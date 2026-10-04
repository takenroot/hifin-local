/**
 * 预算模块内部格式化辅助
 *
 * - formatMoney：已收敛到 @/lib/format，这里仅 re-export 以保持既有 import 路径不变
 * - parseAmount：宽松解析用户输入金额（去逗号 / 空格；非法归零）
 * - periodRange：根据预算周期返回 [from, to)（毫秒）
 * - periodLabel：周期中文文案
 */
export { formatMoney } from '@/lib/format';

/** 解析用户输入金额：允许空 / 去空格 / 不合法归零 */
export function parseAmount(input: string): number {
  if (!input) return 0;
  const cleaned = input.replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

/** 周期中文文案 */
export function periodLabel(period: 'monthly' | 'yearly'): string {
  return period === 'monthly' ? '月度预算' : '年度预算';
}

/**
 * 给定预算周期和参考时刻，返回该周期对应的 [from, to)（毫秒时间戳）
 *  - monthly  → 当前自然月
 *  - yearly   → 当前自然年
 */
export function periodRange(
  period: 'monthly' | 'yearly',
  at: Date = new Date(),
): { from: number; to: number } {
  const y = at.getFullYear();
  const m = at.getMonth();
  if (period === 'monthly') {
    const start = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const end = new Date(y, m + 1, 1, 0, 0, 0, 0).getTime();
    return { from: start, to: end };
  }
  const start = new Date(y, 0, 1, 0, 0, 0, 0).getTime();
  const end = new Date(y + 1, 0, 1, 0, 0, 0, 0).getTime();
  return { from: start, to: end };
}