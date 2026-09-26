/**
 * 报表模块内部格式化辅助
 */

/** ¥ + 千分位 + 2 位小数 */
export function formatMoney(value: number, withSymbol = true): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${withSymbol ? '¥ ' : ''}${sign}${withCommas}.${decPart}`;
}

/** 紧凑金额（用于图表 tooltip）：1234.5 -> 1,234.5 */
export function formatAxis(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_0000_0000) return `${(value / 1_0000_0000).toFixed(1)}亿`;
  if (abs >= 1_0000) return `${(value / 1_0000).toFixed(1)}万`;
  return value.toFixed(0);
}
