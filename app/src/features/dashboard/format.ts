/**
 * 格式化辅助函数（仅供 dashboard 模块内部使用）
 */
import dayjs, { type Dayjs } from 'dayjs';
import type { Transaction } from '@/db';

/** 金额格式化：保留 2 位小数 + 千分位；负数前加 "-" */
export function formatMoney(value: number, withSymbol = true): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${withCommas}.${decPart}`;
  return `${withSymbol ? '¥ ' : ''}${sign}${body}`;
}

/** 百分比格式化：保留 2 位小数 + %；无穷/NaN 归零 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0.00%';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** 同上月环比。base 为本月值，prev 为上月值 */
export function monthOverMonth(base: number, prev: number): number {
  if (prev === 0) {
    return base === 0 ? 0 : 100;
  }
  return ((base - prev) / Math.abs(prev)) * 100;
}

/** 颜色：根据涨跌返回绿/红/灰 */
export function trendToneClass(delta: number, expenseMode = false): string {
  if (delta === 0) return 'text-text-muted';
  // 支出场景下"减少"算好事（绿色），收入场景下"增加"算好事
  const positive = expenseMode ? delta < 0 : delta > 0;
  return positive ? 'text-income' : 'text-expense';
}

/**
 * 账户余额配色：负数走绿色（expense），正数走红色（income）。
 * 与色板约定一致（收入=红、支出=绿）：账户净值为负代表欠款，按"支出"着色。
 * 两个色都是固定色板值，深浅背景下都可读，不需要 dark: 变体。
 */
export function balanceToneClass(balance: number): string {
  return balance < 0 ? 'text-expense' : 'text-income';
}

/** 按时段返回问候语 */
export function greetingByHour(hour: number): string {
  if (hour < 5) return '凌晨好';
  if (hour < 11) return '上午好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

/** 中文星期 */
const WEEKDAY_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
export function weekdayCn(day: Dayjs): string {
  return WEEKDAY_CN[day.day()];
}

/**
 * 月份翻页器文案：2026年10月。
 * 月不补零，与 transactions/TransactionStatsView 的翻页器口径保持一致。
 */
export function monthLabelCn(month: Dayjs): string {
  return month.format('YYYY年M月');
}

/**
 * 收支日历的下界月份：全库最早一笔"日历可见"交易所在的月（月初）。
 *
 * 口径与 buildCalendar 一致——排除 transfer / excluded，否则下界可能落在
 * 一个日历网格画不出任何数据点的月份上。空库返回 null，由调用方回退到当前月。
 * 上界不在这里给：翻页器上界恒为"真实当前月"（未来月没有流水）。
 */
export function earliestTransactionMonth(transactions: Transaction[]): Dayjs | null {
  let min: number | null = null;
  for (const t of transactions) {
    if (t.type === 'transfer' || t.type === 'excluded') continue;
    if (min === null || t.date < min) min = t.date;
  }
  return min === null ? null : dayjs(min).startOf('month');
}