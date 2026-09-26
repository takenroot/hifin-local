/**
 * 目标模块内部格式化辅助
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

/** 解析用户输入金额：允许空 / 去空格 / 不合法归零 */
export function parseAmount(input: string): number {
  if (!input) return 0;
  const cleaned = input.replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** yyyy-MM-dd（给 <input type="date" /> 用） */
export function toDateInput(date: number | undefined | null): string {
  if (!date) return '';
  const d = new Date(date);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** "yyyy-MM-dd" 解析为时间戳（0 时 0 分 0 秒，UTC+8 视为本地） */
export function fromDateInput(value: string): number | undefined {
  if (!value) return undefined;
  const [y, m, d] = value.split('-').map((x) => Number(x));
  if (!y || !m || !d) return undefined;
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  return dt.getTime();
}

/** 截止倒计时文案 */
export function deadlineText(deadline: number | undefined | null): string {
  if (!deadline) return '未设置截止日期';
  const now = Date.now();
  const diffDays = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));
  if (diffDays > 0) return `还剩 ${diffDays} 天`;
  if (diffDays === 0) return '今天到期';
  return `已逾期 ${Math.abs(diffDays)} 天`;
}
