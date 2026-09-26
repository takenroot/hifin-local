/**
 * 账户模块内部格式化辅助函数
 */

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

/** 解析用户输入金额：允许空 / 自动去空格 / 不合法则返回 0 */
export function parseAmount(input: string): number {
  if (!input) return 0;
  const cleaned = input.replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
