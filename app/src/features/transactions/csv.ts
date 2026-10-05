/**
 * 账单 CSV 解析器
 * ---------------------------------------------------------------
 * 不同平台的导出格式：
 *   - 支付宝：时间 / 金额 / 收/支 / 交易对方 / 备注
 *   - 微信：   交易时间 / 金额 / 收/支 / 交易对方 / 备注
 *   - 其余银行：通用映射（按表头行模糊匹配：日期/金额/收/支/对方/备注）
 *
 * 解析过程：
 *   1. 按表头行探测分隔符（逗号 / 制表符 / 分号，整份文件统一；忽略空行与首行 BOM）
 *   2. 找表头并映射字段
 *   3. 逐行解析成 ParsedTx（解析失败保留 rawLine）
 * ---------------------------------------------------------------
 */
import type { TransactionType } from '@/db';

/**
 * 溯源来源。与 core 的 transactions.source 同口径：
 * 只有支付宝/微信两家有自己的账单解析口径，其余（cmb/icbc/generic…）一律归 'csv'。
 */
export type TxSource = 'alipay' | 'wechat' | 'csv';

export interface PlatformDef {
  id: string;
  name: string;
  /** 显示在选择列表里的副标题/说明 */
  hint?: string;
}

export const PLATFORMS: PlatformDef[] = [
  { id: 'alipay', name: '支付宝' },
  { id: 'wechat', name: '微信支付' },
  { id: 'cmb', name: '招商银行' },
  { id: 'icbc', name: '工商银行' },
  { id: 'abc', name: '农业银行' },
  { id: 'cgb', name: '广发银行' },
  { id: 'boc', name: '中国银行' },
  { id: 'ccb', name: '建设银行' },
  { id: 'generic', name: '通用 CSV' },
];

export interface ParsedTx {
  date: number;
  amount: number;
  type: TransactionType;
  merchant: string;
  remark?: string;
  /** 平台自带的粗粒度分类：支付宝「交易分类」/ 微信「交易类型」。没有这列时为 undefined。 */
  billCategory?: string;
  /** 溯源来源：'alipay' / 'wechat' / 'csv'（其它平台账单一律归 csv） */
  source?: TxSource;
  /** 平台交易单号：支付宝「交易订单号」/ 微信「交易单号」 */
  externalId?: string;
  /** 支付方式主渠道：组合支付已取 & 前段，如「花呗&余额宝」→「花呗」 */
  paymentMethod?: string;
  /** 交易状态原文：如「交易成功」/「已全额退款」 */
  status?: string;
  /** 解析错误 */
  rawLine?: string;
}

interface FieldMap {
  date: number;
  amount: number;
  type: number;
  merchant: number;
  remark: number;
  /** 平台自带分类列，无则 -1 */
  billCategory: number;
  /** 平台交易单号列，无则 -1 */
  externalId: number;
  /** 支付方式列，无则 -1 */
  paymentMethod: number;
  /** 交易状态列，无则 -1 */
  status: number;
}

/* ---------- CSV 文本 → 二维数组 ---------- */

const DELIMS = [',', '\t', ';'];

/**
 * 按**表头行**猜一个分隔符，整份文件统一用它切。
 *
 * 原先每个字符位上把 `,` `\t` `;` 同时当分隔符，于是逗号 CSV 里某个字段**内含**
 * 一个制表符（支付宝「交易订单号」尾部就有）时会被硬生生多切一列，后面所有字段
 * 整体右移一格：
 *   - 多切点落在「金额」列之前 → 金额列读到「支出」→ parseAmount 返回 null
 *     → 该行被判解析失败、丢进 rawLine（正是这 1 笔 ¥39.35 的下场）；
 *   - 落在「金额」列之后 → 金额还读得对，但「商家订单号」会顶替「备注」
 *     被静默写进库（错值不报错，更难发现）。
 * 一份账单只有一个分隔符，猜一次就够；TSV / 分号表照样认得出来。
 */
function detectDelimiter(line: string): string {
  const counts = new Map<string, number>();
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && DELIMS.includes(ch)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  let best = ',';
  let bestCount = 0;
  for (const d of DELIMS) {
    const n = counts.get(d) ?? 0;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best; // 一个候选都没出现（如无表头的提示行）→ 退回 ','
}

function splitCsvLine(line: string, delim: string): string[] {
  // 极简 CSV 解析：支持双引号包裹 + 单一分隔符；不做 RFC 完整实现
  // （字段里未转义的分隔符仍会错位——那是 CSV 本身的歧义，无从判别）
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delim) {
        cells.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text: string): string[][] {
  // 去 BOM
  const cleaned = text.replace(/^\uFEFF/, '');
  const lines = cleaned.split(/\r?\n/).filter((l) => l.trim().length > 0);
  // 表头就在第 1 行时 findHeaderLine 返回 0，body === lines，行为与从前逐字一致
  const headerIdx = findHeaderLine(lines);
  const body = headerIdx > 0 ? lines.slice(headerIdx) : lines;
  // 分隔符按**表头行**猜：有前言时拿第 1 行猜会猜到分隔线的 ',' 上
  const delim = detectDelimiter(body[0] ?? '');
  return body.map((l) => splitCsvLine(l, delim));
}

/**
 * 找真正的那一行表头；找不到返回 -1。
 *
 * 支付宝导出前 20 多行是导出说明（分隔线、账号、统计、特别提示…），真正的表头在
 * 后面。判据直接用 `buildFieldMap`——也就是「解析器自己认不认这一行当表头」，
 * 不另写一份关键词表：既与下游口径天然一致，也不会把前言里恰好带「日期」的说明行
 * 误当表头（那种说明行没有金额列，buildFieldMap 照样返回 null）。
 *
 * `cells.length >= 2` 这道门槛是给**单格预览行**准备的：前言里常见
 * 「序号 交易时间 交易分类 交易对方 收/支 金额」这种用空格排版的示意行，
 * 整行只有一个 cell，日期和金额的别名都落在同一格里，buildFieldMap 会放它过关。
 * 真表头至少两列（日期一列、金额一列），所以这道门槛只挡假阳性。
 */
function findHeaderLine(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], detectDelimiter(lines[i]));
    if (cells.length >= 2 && buildFieldMap(cells)) return i;
  }
  return -1;
}

/**
 * 账单字节 → 文本。手动上传路径用（core 读的是 ZIP 里的文件，走自己的解码）。
 *
 * 支付宝导出是 GBK，微信/银行多半是 UTF-8。**UTF-8 先试**：它的语法比 GBK 严得多
 * （GBK 只要「高字节 + 0x40-0xFE」就成字，UTF-8 的中文三字节序列经常能被它整个
 * 吃掉且不抛错，解出一份不报错的乱码）。反过来先试 GBK 才真的危险。
 * 实测：真实支付宝原件在 utf-8 fatal 下抛错，转存成 UTF-8 后在 gbk fatal 下抛错，
 * 两个方向都靠 fatal 判别得出来。
 */
export function decodeBillBytes(buf: ArrayBuffer): string {
  for (const enc of ['utf-8', 'gbk']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {
      // 不是这个编码，换下一个
    }
  }
  // 两个都不干净（混编/截断）：非致命解码兜底，好过直接抛错
  return new TextDecoder('utf-8').decode(buf);
}

/* ---------- 字段匹配 ---------- */

const COL_ALIASES = {
  date: ['日期', '时间', '交易时间', '交易日期', 'date', 'time', 'datetime'],
  amount: ['金额', 'amount', 'money', 'price'],
  type: ['收/支', '收支', '类型', '方向', 'type', 'direction'],
  merchant: ['对方', '商户', '交易对方', '对手方', '收款方', '付款方', 'merchant', 'counterparty', 'payee'],
  remark: ['备注', '说明', 'remark', 'note', 'memo', 'summary'],
  // 平台自己给的粗粒度分类。支付宝表头是「交易分类」，微信是「交易类型」，
  // 两者互不包含，谁先谁后无所谓。
  //
  // 真正要留意的是**别的数组**里那条 '类型' 兜底别名（见上方 type）：微信表头同时
  // 有「交易类型」和「收/支」，若 type 的别名顺序不是 '收/支' 在前，整列「交易类型」
  // 会被当成收支方向，所有行变 transfer 并被静默丢弃。改动 type 的别名顺序时，
  // 请连带检查这里。
  billCategory: ['交易分类', '交易类型'],
  // ── 溯源四件套（v2）──
  // 单号：支付宝「交易订单号」/ 微信「交易单号」。两家的表里都还有一列商户单号
  // （支付宝「商家订单号」/ 微信「商户单号」），刻意**不**收进别名——商户单号是
  // 商家侧生成的、可能为空也可能重复，当不了去重键。微信表里 findCol 取首个命中，
  // 「交易单号」排在「商户单号」前面且不是它的子串，所以能稳定拿到交易单号。
  externalId: ['交易订单号', '交易单号', '交易号', '订单号'],
  // 支付方式：支付宝「收/付款方式」/ 微信「支付方式」。
  paymentMethod: ['收/付款方式', '支付方式', '付款方式'],
  // 交易状态：支付宝「交易状态」/ 微信「当前状态」。
  // 微信的「交易类型」不含"状态"二字、支付宝的「交易分类」也不含，
  // 所以这条别名不会误抓到分类列。
  status: ['交易状态', '当前状态', '状态'],
};

/** 找列下标；返回 -1 表示无匹配 */
function findCol(headers: string[], aliases: string[]): number {
  for (const alias of aliases) {
    const idx = headers.findIndex((h) => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

function buildFieldMap(headers: string[]): FieldMap | null {
  const date = findCol(headers, COL_ALIASES.date);
  const amount = findCol(headers, COL_ALIASES.amount);
  const type = findCol(headers, COL_ALIASES.type);
  const merchant = findCol(headers, COL_ALIASES.merchant);
  const remark = findCol(headers, COL_ALIASES.remark);
  const billCategory = findCol(headers, COL_ALIASES.billCategory);
  const externalId = findCol(headers, COL_ALIASES.externalId);
  const paymentMethod = findCol(headers, COL_ALIASES.paymentMethod);
  const status = findCol(headers, COL_ALIASES.status);
  if (date === -1 || amount === -1) return null;
  return { date, amount, type, merchant, remark, billCategory, externalId, paymentMethod, status };
}

/* ---------- 单元格解析 ---------- */

function parseDate(cell: string): number | null {
  if (!cell) return null;
  const trimmed = cell.trim();
  // 兼容 2024/01/02 12:30 之类
  const m = trimmed.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
    const date = new Date(+y, +mo - 1, +d, +h, +mi, +s);
    return date.getTime();
  }
  // 直接尝试 ISO 解析
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) return ts;
  return null;
}

function parseAmount(cell: string): number | null {
  if (!cell) return null;
  const cleaned = cell.replace(/[¥￥,\s]/g, '');
  const num = Number(cleaned);
  return Number.isFinite(num) ? Math.abs(num) : null;
}

function parseType(cell: string): TransactionType {
  const v = (cell || '').trim();
  // 支付宝 / 微信：支出 / 收入 / / (空表示不计)
  if (v.includes('支出')) return 'expense';
  if (v.includes('收入')) return 'income';
  if (v.includes('不计') || v.includes('中性') || v === '') return 'excluded';
  if (v.includes('转出')) return 'transfer';
  if (v.includes('转入')) return 'transfer';
  // 银行：借/贷 / 出/入
  if (v.includes('借')) return 'expense';
  if (v.includes('贷')) return 'income';
  // 兜底
  return 'excluded';
}

/**
 * 平台占位符。
 *
 * 两家账单在"这格没有内容"时写的是半角 `/`，不是空串。它在**每一列**都可能出现
 * （交易对方、商品、支付方式、备注…）。原样存进 transactions 会得到一堆
 * 看着像内容、实际是空值的 remark/name，所以统一规整成 undefined → NULL。
 */
const PLACEHOLDER = '/';

/** 规整备注：`/`（平台占位符）→ undefined，其余去首尾空白后原样带出。 */
function normalizeRemark(raw: string): string | undefined {
  const v = (raw || '').trim();
  if (!v || v === PLACEHOLDER) return undefined;
  return v;
}

/**
 * 规整支付方式：组合支付取 `&` 前段的主渠道。
 *
 * 支付宝一笔可能同时走多个优惠渠道，全值形如
 *   「工商银行储蓄卡(1230)&工商银行立减金」/「花呗&花呗信用购立减&现金抵价券」
 * 第一段恒为主支付渠道，后面的都是叠加的立减/券，落库只留主渠道才有分析价值。
 * 微信不产生 `&`，原样返回。
 */
function normalizePaymentMethod(raw: string): string | undefined {
  const v = (raw || '').trim();
  if (!v || v === PLACEHOLDER) return undefined;
  return v.split('&')[0].trim() || undefined;
}

/** 单号/状态：只去首尾空白，空值（含 `/`）→ undefined。 */
function normalizePlain(raw: string): string | undefined {
  const v = (raw || '').trim();
  if (!v || v === PLACEHOLDER) return undefined;
  return v;
}

/** 平台 id → transactions.source。只有支付宝/微信有自己的口径，其余归 'csv'。 */
function normalizeSource(platform: string): TxSource {
  return platform === 'alipay' || platform === 'wechat' ? platform : 'csv';
}

/* ---------- 平台分发 ---------- */

function detectPlatform(headers: string[]): string {
  const head = headers.join(',');
  if (head.includes('交易对方') && head.includes('收/支')) {
    if (head.includes('收/支')) return 'alipay';
  }
  if (head.includes('交易时间') && head.includes('收/支')) return 'wechat';
  // 兜底
  return 'generic';
}

export interface ParseResult {
  platform: string;
  total: number;
  valid: number;
  items: ParsedTx[];
  /** 没有列头 / 解析失败 */
  error?: string;
}

export function parseCsvText(text: string, platformHint?: string): ParseResult {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return { platform: platformHint ?? 'generic', total: 0, valid: 0, items: [], error: '空文件' };
  }
  const headers = rows[0];
  const map = buildFieldMap(headers);
  let platform = platformHint ?? 'generic';
  if (!platformHint) platform = detectPlatform(headers);

  if (!map) {
    return {
      platform,
      total: rows.length - 1,
      valid: 0,
      items: [],
      error: '未识别到日期/金额列，请确保表头包含"日期"和"金额"',
    };
  }

  const items: ParsedTx[] = [];
  let valid = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const dateCell = r[map.date];
    const amountCell = r[map.amount];
    const typeCell = map.type !== -1 ? r[map.type] : '';
    const merchantCell = map.merchant !== -1 ? r[map.merchant] : '';
    const remarkCell = map.remark !== -1 ? r[map.remark] : '';
    const billCategoryCell = map.billCategory !== -1 ? r[map.billCategory] : '';
    const externalIdCell = map.externalId !== -1 ? r[map.externalId] : '';
    const paymentMethodCell = map.paymentMethod !== -1 ? r[map.paymentMethod] : '';
    const statusCell = map.status !== -1 ? r[map.status] : '';

    const date = parseDate(dateCell);
    const amount = parseAmount(amountCell);
    if (!date || amount === null) {
      items.push({
        date: 0,
        amount: 0,
        type: 'excluded',
        merchant: '',
        rawLine: r.join(','),
      });
      continue;
    }
    items.push({
      date,
      amount,
      type: parseType(typeCell),
      merchant: merchantCell || '',
      remark: normalizeRemark(remarkCell),
      // 原样带出（不 trim），归一化交给消费方的 resolveBillCategory，
      // 免得解析层和映射层各有一套去空白规则
      billCategory: billCategoryCell ? String(billCategoryCell) : undefined,
      source: normalizeSource(platform),
      externalId: normalizePlain(externalIdCell),
      paymentMethod: normalizePaymentMethod(paymentMethodCell),
      status: normalizePlain(statusCell),
    });
    valid++;
  }

  return { platform, total: rows.length - 1, valid, items };
}

/** 简易 CSV 转义 */
export function escapeCsv(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
