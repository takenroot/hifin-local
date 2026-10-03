/**
 * 账单 ZIP → CSV → 交易入库
 *
 * 流程（每一步都可能独立失败，错误原样向上抛，不吞）：
 *   1. unzipBill      用平台密码解压（每次申请账单时不同，见最新邮件/短信）
 *   2. findBillCsv    在解出的文件里挑账单表格（.csv 优先，.txt 兜底）
 *   3. 动态 import app/src/features/transactions/csv.ts 的 parseCsvText
 *      （与前端共用同一份解析器，避免"导入的数和页面上看到的数对不上"）
 *   4. importTransactions  事务内插交易 + 联动账户余额 + 规则自动分类
 *
 * 整个第 4 步再包一层事务：importTransactions 内部已经是事务（better-sqlite3
 * 嵌套事务走 SAVEPOINT），外层这层保证"CSV 解析结果 → 落库"整体原子。
 *
 * 可选的 onProgress 在事务提交后回调一次已写入行数，供 poller 推进度提示。
 */

import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { unzipBill, findBillCsv, cleanupBillDir, BillCsvNotFoundError } from './unzip.js';
import { importTransactions, type AccountMap } from '../mail/importer.js';
import type { ParsedTx } from '../mail/parsers/base.js';
import {
  isSelfTransfer,
  isEffectiveTransferStatus,
  parseAlipayRepayTransfer,
  parseWechatTransfer,
} from './account-map.js';

/** 当前 MVP 只支持这两个平台的加密账单 ZIP */
export type BillPlatform = 'alipay' | 'wechat';

/** importBillZip 的返回值 */
export interface ImportBillResult {
  /** 实际写入 transactions 的行数 */
  imported: number;
  /** 跳过的行数：解析失败的行 + 不计收支的行 + 重复行 */
  skipped: number;
  /** 平台标识（入参原样回传，便于调用方对齐账目来源） */
  platform: string;
  /** 本次解压出的文件绝对路径，便于 CLI 打印给用户核对 */
  files: string[];
  /**
   * 因为"账户不存在"而被降级到兜底账户的划转（账户名 → 笔数）。
   *
   * 空对象表示一切正常。调用方（CLI/进度提示）应该把它讲给用户听：
   * 划转账的**钱数是对的**（记到了兜底账户上），但归属可能不是用户以为的那个，
   * 只在静默落库不吭声的话，用户会以为导入没问题。
   */
  unmappedTransfers?: Record<string, number>;
  /**
   * 因"归并后自己转自己"被跳过的行数（实测微信"转入零钱通-来自零钱"13 行）。
   *
   * 它们不是解析失败，是**本来就不该记**：钱在同一个账户里转了一圈，
   * 记下来只会给流水表灌一堆零余额的噪声转账。
   */
  selfTransfers?: number;
}

/** app 侧 parseCsvText 的返回结构（只声明用得到的字段） */
interface AppParseResult {
  platform: string;
  total: number;
  valid: number;
  items: Array<{
    date: number;
    amount: number;
    type: string;
    merchant: string;
    remark?: string;
    /** 平台自带分类：支付宝「交易分类」/ 微信「交易类型」 */
    billCategory?: string;
    /** 溯源来源：alipay / wechat / csv */
    source?: string;
    /** 平台交易单号（微信「交易单号」/ 支付宝「交易订单号」） */
    externalId?: string;
    /** 支付方式主渠道（组合支付已在解析层取 & 前段） */
    paymentMethod?: string;
    /** 交易状态原文 */
    status?: string;
    rawLine?: string;
  }>;
  error?: string;
}

/**
 * 动态加载 app 的 CSV 解析器。
 *
 * app 的 csv.ts 里有 `@/db` 这类路径别名，tsc 跨 rootDir 校验不了，只能在运行时
 * 由 tsx 解析。所以这里不写死相对层级（src/ 与 dist/ 深度还可能随构建变化），
 * 而是从本文件所在目录一路往上找，找到第一个存在的 app/src/features/…/csv.ts。
 */
async function loadCsvParser(): Promise<(text: string, platformHint?: string) => AppParseResult> {
  const rel = 'app/src/features/transactions/csv.ts';
  let dir = dirname(fileURLToPath(import.meta.url));
  let csvUrl: string | null = null;
  for (let i = 0; i < 6; i++) {
    const candidate = resolve(dir, rel);
    if (existsSync(candidate)) {
      csvUrl = pathToFileURL(candidate).href;
      break;
    }
    const up = dirname(dir);
    if (up === dir) break; // 到了文件系统根
    dir = up;
  }
  if (!csvUrl) {
    throw new Error(`找不到前端 CSV 解析器（${rel}）——请确认 hifin/app 目录存在`);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import(csvUrl)) as any;
  const fn = mod.parseCsvText as ((text: string, platformHint?: string) => AppParseResult) | undefined;
  if (typeof fn !== 'function') {
    throw new Error('app/src/features/transactions/csv.ts 未导出 parseCsvText');
  }
  return fn;
}

/**
 * 平台 id → transactions.source 的取值。
 *
 * 与 app 侧 csv.ts 的 normalizeSource 同一口径：只有支付宝/微信有自己的账单
 * 语义，其余（cmb/icbc/generic…）一律记 'csv'。放在 core 是为了让回填脚本
 * （scripts/backfill-fields.ts）也能拿到同一份规则，不至于两处各写一遍。
 */
export function normalizeSource(platform: string | null | undefined): string {
  return platform === 'alipay' || platform === 'wechat' ? platform : 'csv';
}

/**
 * 把 app 解析结果收敛成 core 的 ParsedTx[]。
 *
 * 除了收支行，这里还负责把**划转行救回来**：
 * 微信「转入零钱通/零钱通转出」和支付宝「花呗还款成功」在账单里的收/支列
 * 都写着 `/`，app 的 parseType() 因此给出 'excluded'，在本次改造前
 * 一律按"不计收支"丢弃（实测微信 27 行、支付宝 10 行还款被丢）。
 * 它们是账户之间的钱搬家，不记的话两边的余额都会错，所以这里按
 * 账户名产出 type='transfer' 的行，方向交给 importTransactions 落库。
 *
 * platform + billCategory 一起带下去：分类决策要靠它们查 category-map 的映射表，
 * 单独传 billCategory 而不传 platform 的话，importTransactions 无从判断这是
 * 微信的"交易类型"还是某个银行流水的"交易类型"（后者语义完全不同，不能乱套）。
 *
 * resolveTransfers 决定要不要把不计收支行救成划转：**只在调用方给了
 * accountMap 时才为 true**。没有分流表就没有账户 id 可落，一条"转出却
 * 不知道转入到哪儿"的流水只会让余额凭空少一块——那正是改造前这些行被丢弃
 * 的原因。保持它为 false 才算真正的向后兼容：没启用多账户的用户，
 * 同一份账单导入后行数与余额与改造前逐项一致。
 */
function toCoreTxs(
  items: AppParseResult['items'],
  platform: string,
  resolveTransfers: boolean,
): { txs: ParsedTx[]; dropped: number; selfTransfers: number } {
  const txs: ParsedTx[] = [];
  let dropped = 0;
  let selfTransfers = 0;
  for (const it of items) {
    // 解析失败的行（rawLine 有值）与不计收支的行都不入库
    if (it.rawLine || !it.date || !it.amount) {
      dropped++;
      continue;
    }

    const base = {
      date: it.date,
      amount: it.amount,
      merchant: it.merchant || '账单导入',
      remark: it.remark,
      billCategory: it.billCategory,
      platform,
      // 溯源四件套：优先用解析层给的 source（它已经认得 alipay/wechat/其它），
      // 拿不到就按 platform 兜底，两者都认不出（银行/通用账单）时归 'csv'。
      source: it.source ?? normalizeSource(platform),
      externalId: it.externalId,
      paymentMethod: it.paymentMethod,
      status: it.status,
    };

    if (it.type !== 'expense' && it.type !== 'income') {
      // 不计收支的行还有一种可能是账户间划转，试着救回来
      const legs = resolveTransfers ? detectTransfer(it, platform) : null;
      if (legs) {
        /**
         * 归并后自己转自己（实测"转入零钱通-来自零钱"13 行）必须跳过。
         * 记下来会给同一个账户加一笔再减一笔，余额对得上、流水表里却凭空
         * 多出一堆无意义的转账，资产分布也会被它搅乱。
         */
        if (isSelfTransfer(legs)) {
          selfTransfers++;
          dropped++;
          continue;
        }
        txs.push({
          ...base,
          type: 'transfer',
          merchant: it.merchant || '账户划转',
          fromAccountName: legs.fromAccountName,
          toAccountName: legs.toAccountName,
        });
        continue;
      }
      dropped++;
      continue;
    }

    txs.push({ ...base, type: it.type });
  }
  return { txs, dropped, selfTransfers };
}

/**
 * 这一行是不是账户间划转；是则给出两端账户名，不是返回 null。
 *
 * 认得两种：
 *   - 微信：交易类型形如「转入零钱通-来自X」/「零钱通转出-到X」
 *   - 支付宝：交易状态=还款成功且对方/分类指向花呗/信用
 *
 * 状态闸门在各自的条件里：微信"转出失败"、支付宝"还款失败"都不生成，
 * 与账单里"不计收支"那一列的语义一致——没动过钱的不该联动余额。
 */
function detectTransfer(
  it: AppParseResult['items'][number],
  platform: string,
): { fromAccountName: string; toAccountName: string } | null {
  if (platform === 'wechat') {
    if (!isEffectiveTransferStatus(it.status)) return null;
    return parseWechatTransfer(it.billCategory);
  }
  if (platform === 'alipay') {
    return parseAlipayRepayTransfer(it.status, it.merchant, it.billCategory, it.paymentMethod);
  }
  return null;
}

/**
 * 解压账单 ZIP 并把其中的 CSV 导入到指定账户。
 *
 * @param db        已 migrate 的数据库连接
 * @param zipPath   账单 ZIP 路径
 * @param platform  平台（alipay / wechat）
 * @param password  解压密码（每次申请账单时不同，必须显式传入）
 * @param accountId 导入到哪个账户（必须已存在）
 * @param spaceId   空间 ID，默认 1
 * @param onProgress 入库完成后回调一次已写入行数（poller 用它把"正在解压…"换成"已导入 N 笔"）。
 *                   可选、纯旁路：抛错会被吞掉，绝不影响导入结果。
 * @param accountMap 账户名 → id 的分流表（可选）。
 *                   传了：普通收支行按 paymentMethod 落到对应账户、划转按两端账户名落；
 *                   不传：行为与改造前完全一致（所有行都进 accountId），保证向后兼容。
 */
export async function importBillZip(
  db: Database.Database,
  zipPath: string,
  platform: BillPlatform | string,
  password: string,
  accountId: number,
  spaceId?: number,
  onProgress?: (imported: number) => void,
  accountMap?: AccountMap,
): Promise<ImportBillResult> {
  if (!Number.isFinite(accountId) || accountId <= 0) {
    throw new Error('accountId 必须是正整数');
  }
  if (!password) {
    throw new Error('解压密码不能为空：每次申请账单的密码都不同，请查看最新账单邮件/短信中的密码');
  }
  const pwd = password;

  const files = unzipBill(zipPath, pwd);
  try {
    // 优先找 CSV/TXT；找不到则尝试 xlsx（微信账单是 Excel 格式）
    let csvPath = findBillCsv(files);
    let text: string;
    let billFileName: string;

    if (csvPath) {
      billFileName = basename(csvPath);
      const buf = readFileSync(csvPath);
      // 支付宝/微信账单 CSV 默认 GBK 编码；先按 GBK 解码，失败再回退 UTF-8
      try {
        text = new TextDecoder('gbk', { fatal: true }).decode(buf);
      } catch {
        text = new TextDecoder('utf-8').decode(buf);
      }
      // 支付宝 CSV 前 ~22 行是导出说明/回单抬头，找到第一个含"交易时间"的表头行
      const lines = text.split(/\r?\n/);
      const headerIdx = lines.findIndex((l) => l.includes('交易时间') || l.includes('日期'));
      if (headerIdx > 0) {
        text = lines.slice(headerIdx).join('\n');
      }
    } else {
      // 微信账单：xlsx → 转 CSV 文本
      const xlsxPath = files.find((f) => /\.xlsx$/i.test(f));
      if (!xlsxPath) {
        throw new BillCsvNotFoundError(
          `ZIP 里没有找到账单表格（.csv/.txt/.xlsx）：${basename(zipPath)}，解出 ${files.length} 个文件`,
        );
      }
      billFileName = basename(xlsxPath);
      text = xlsxToCsvText(xlsxPath);
    }

    const parseCsvText = await loadCsvParser();
    const parsed = parseCsvText(text, platform);
    if (parsed.error && parsed.items.length === 0) {
      throw new BillCsvNotFoundError(`账单表格无法解析（${billFileName}）：${parsed.error}`);
    }

    const { txs, dropped, selfTransfers } = toCoreTxs(parsed.items, platform, !!accountMap);

    // 外层事务：解析 → 落库整体原子（内层 importTransactions 走 SAVEPOINT）
    const res = db.transaction(() =>
      importTransactions(db, txs, accountId, { spaceId: spaceId ?? 1, accountMap }),
    )();

    // 进度回调是纯旁路：用户的 UI 回调挂了不该让整笔导入算失败
    try {
      onProgress?.(res.imported);
    } catch {
      /* ignore */
    }

    return {
      imported: res.imported,
      // 自转（"转入零钱通-来自零钱"）算跳过：钱确实没动，记一笔就是噪声
      skipped: res.skipped + dropped,
      platform,
      files,
      // 划转有终点账户时才有降级报告；没起 accountMap 则根本不分流，无从谈起
      ...(accountMap && res.unmappedTransfers && Object.keys(res.unmappedTransfers).length > 0
        ? { unmappedTransfers: res.unmappedTransfers }
        : {}),
      ...(selfTransfers > 0 ? { selfTransfers } : {}),
    };
  } finally {
    cleanupBillDir(tempRootOf(files));
  }
}

/**
 * 把微信账单的 .xlsx 转成 CSV 文本，复用现有 parseCsvText 解析。
 * 微信 xlsx 特点：
 *   - 前 ~17 行是导出说明，表头在"交易时间"所在行
 *   - 交易时间是 Excel 日期序列号（如 46292.533），需要转回日期字符串
 *   - 金额列名是"金额(元)"
 *
 * 导出来是为了让 scripts/ 下的回填脚本复用同一套 xlsx→CSV 转换，
 * 免得"导入时看到的日期"和"回填时算出来的日期"对不上。
 */
export function xlsxToCsvText(xlsxPath: string): string {
  const require = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = require('xlsx') as any;
  const wb = XLSX.readFile(xlsxPath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  // 找表头行（含"交易时间"）
  const headerIdx = rows.findIndex((r) => Array.isArray(r) && r.some((c) => String(c).includes('交易时间')));
  if (headerIdx < 0) {
    throw new BillCsvNotFoundError(`xlsx 里找不到「交易时间」表头：${basename(xlsxPath)}`);
  }

  const dataRows = rows.slice(headerIdx);
  const csvLines = dataRows.map((row) => {
    return row
      .map((cell) => {
        if (cell === null || cell === undefined) return '';
        // Excel 日期序列号 → 格式化字符串
        if (typeof cell === 'number' && cell > 40000 && cell < 60000) {
          const date = excelDateToJsDate(cell);
          return formatDate(date);
        }
        const s = String(cell);
        // 含逗号/引号/换行的字段需要包裹
        if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
        return s;
      })
      .join(',');
  });

  return csvLines.join('\n');
}

/** Excel 日期序列号 → JS Date（Excel 纪元 1900-01-01，有 1900 闰年 bug 偏移） */
function excelDateToJsDate(serial: number): Date {
  const utcDays = Math.floor(serial - 25569); // 25569 = 1970-01-01 的 Excel 序列号
  const utcValue = utcDays * 86400 * 1000;
  const fraction = serial - Math.floor(serial);
  const timeValue = Math.round(fraction * 86400) * 1000;
  return new Date(utcValue + timeValue);
}

/** 格式化为 parseCsvText 能识别的日期字符串 */
function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const min = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${y}-${m}-${day} ${h}:${min}:${s}`;
}

/**
 * 从解出的文件反推 unzipBill 自建的临时根目录。
 * 压缩包内部可能带子目录（"账单/明细.csv"），所以不能只看第一个文件的父目录，
 * 得一路上溯到带 hifin-bill- 前缀的那一层；cleanupBillDir 也只认这个前缀。
 */
function tempRootOf(files: string[]): string {
  let dir = files[0] ? dirname(files[0]) : '';
  // 上限防御：正常一两层就到头，兜底不让 while 跑飞
  for (let i = 0; i < 16 && dir && dirname(dir) !== dir; i++) {
    if (basename(dir).startsWith('hifin-bill-')) return dir;
    dir = dirname(dir);
  }
  return '';
}
