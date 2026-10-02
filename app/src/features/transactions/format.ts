/**
 * 交易流水模块内部格式化辅助
 */

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
