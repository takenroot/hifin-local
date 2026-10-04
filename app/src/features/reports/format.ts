/**
 * 报表模块内部格式化辅助
 *
 * formatMoney 已收敛到 @/lib/format，这里仅 re-export 以保持既有 import 路径不变。
 */
export { formatMoney } from '@/lib/format';

/** 紧凑金额（用于图表 tooltip）：1234.5 -> 1,234.5 */
export function formatAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(1)}亿`;
  if (abs >= 1_0000) return `${(value / 1_0000).toFixed(1)}万`;
  return value.toFixed(0);
}
