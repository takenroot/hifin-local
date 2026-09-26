/**
 * 交易流水模块内部格式化辅助
 */
import dayjs from 'dayjs';

/** 金额格式化：¥ + 千分位 + 2 位小数 */
export function formatMoney(value: number, withSymbol = true): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${withCommas}.${decPart}`;
  return `${withSymbol ? '¥ ' : ''}${sign}${body}`;
}

/** 给 /datetime-local 输入做格式化：YYYY-MM-DDTHH:mm */
export function toDatetimeLocal(date: number | Date): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 时间戳 -> 日期分组 key。
 * 今天 / 昨天 / 具体日期(YYYY年M月D日 星期X)
 */
export function groupKey(date: number, today: dayjs.Dayjs): string {
  const t = today.startOf('day');
  const d = dayjs(date);
  const target = d.startOf('day');
  if (target.isSame(t)) return '今天';
  if (target.isSame(t.subtract(1, 'day'))) return '昨天';
  return d.format('YYYY年M月D日 ddd');
}
