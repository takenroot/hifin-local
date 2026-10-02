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
import { importTransactions } from '../mail/importer.js';
import type { ParsedTx } from '../mail/parsers/base.js';

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
 * 把 app 解析结果收敛成 core 的 ParsedTx[]。
 * app 的 type 还包含 transfer / excluded，而 core 的 ParsedTx 只认收支两类；
 * 不计收支的行按"跳过"计，不进库。
 */
function toCoreTxs(items: AppParseResult['items']): { txs: ParsedTx[]; dropped: number } {
  const txs: ParsedTx[] = [];
  let dropped = 0;
  for (const it of items) {
    // 解析失败的行（rawLine 有值）与不计收支的行都不入库
    if (it.rawLine || !it.date || !it.amount) {
      dropped++;
      continue;
    }
    if (it.type !== 'expense' && it.type !== 'income') {
      dropped++;
      continue;
    }
    txs.push({
      date: it.date,
      amount: it.amount,
      type: it.type,
      merchant: it.merchant || '账单导入',
      remark: it.remark,
    });
  }
  return { txs, dropped };
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
 */
export async function importBillZip(
  db: Database.Database,
  zipPath: string,
  platform: BillPlatform | string,
  password: string,
  accountId: number,
  spaceId?: number,
  onProgress?: (imported: number) => void,
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

    const { txs, dropped } = toCoreTxs(parsed.items);

    // 外层事务：解析 → 落库整体原子（内层 importTransactions 走 SAVEPOINT）
    const res = db.transaction(() =>
      importTransactions(db, txs, accountId, { spaceId: spaceId ?? 1 }),
    )();

    // 进度回调是纯旁路：用户的 UI 回调挂了不该让整笔导入算失败
    try {
      onProgress?.(res.imported);
    } catch {
      /* ignore */
    }

    return {
      imported: res.imported,
      skipped: res.skipped + dropped,
      platform,
      files,
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
 */
function xlsxToCsvText(xlsxPath: string): string {
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
