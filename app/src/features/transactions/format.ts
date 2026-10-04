/**
 * 交易流水模块内部格式化辅助
 *
 * formatMoney 已收敛到 @/lib/format，这里仅 re-export 以保持既有 import 路径不变。
 */
export { formatMoney } from '@/lib/format';

/** 给 /datetime-local 输入做格式化：YYYY-MM-DDTHH:mm */
export function toDatetimeLocal(date: number | Date): string {
  const d = typeof date === 'number' ? new Date(date) : date;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
