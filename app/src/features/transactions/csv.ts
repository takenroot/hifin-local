/**
 * 账单 CSV 解析器
 * ---------------------------------------------------------------
 * 不同平台的导出格式：
 *   - 支付宝：时间 / 金额 / 收/支 / 交易对方 / 备注
 *   - 微信：   交易时间 / 金额 / 收/支 / 交易对方 / 备注
 *   - 其余银行：通用映射（按表头行模糊匹配：日期/金额/收/支/对方/备注）
 *
 * 解析过程：
 *   1. 智能分隔（CSV, TSV, 半角逗号；忽略空行与首行 BOM）
 *   2. 找表头并映射字段
 *   3. 逐行解析成 ParsedTx（解析失败保留 rawLine）
 * ---------------------------------------------------------------
 */
import type { TransactionType } from '@/db';

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
}

/* ---------- CSV 文本 → 二维数组 ---------- */

function splitCsvLine(line: string): string[] {
  // 极简 CSV 解析：支持双引号包裹、半角逗号 / 制表符；不做 RFC 完整实现
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
      } else if (ch === ',' || ch === '\t' || ch === ';') {
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
  return cleaned
    .split(/\r?\n/)
    .map((l) => l)
    .filter((l) => l.trim().length > 0)
    .map(splitCsvLine);
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
  if (date === -1 || amount === -1) return null;
  return { date, amount, type, merchant, remark, billCategory };
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
      remark: remarkCell || undefined,
      // 原样带出（不 trim），归一化交给消费方的 resolveBillCategory，
      // 免得解析层和映射层各有一套去空白规则
      billCategory: billCategoryCell ? String(billCategoryCell) : undefined,
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
