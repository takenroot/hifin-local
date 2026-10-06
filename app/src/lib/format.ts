/**
 * 全局格式化辅助（跨 feature 共用，单一实现）
 *
 * 历史包袱：早期各 feature 各自复制了一份 formatMoney / PIE_COLORS /
 * balanceToneClass，dashboard 与 accounts 的两份 balanceToneClass 还曾
 * 出现口径分歧（零值配色不一致）。现已全部收敛到本文件，各 feature
 * 的 format.ts 仅做 re-export，新增格式化函数请直接加在这里。
 */

/** 金额格式化：¥ + 千分位 + 2 位小数；负数前加 "-" */
export function formatMoney(value: number, withSymbol = true): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const body = `${withCommas}.${decPart}`;
  return `${withSymbol ? '¥ ' : ''}${sign}${body}`;
}

/**
 * 账户余额 / 合计的配色类（统一口径：以 accounts 版为准）。
 *
 * 沿用全局财务约定（2026-10-06 主题还原）：绿=好事（有钱），红=坏事（欠钱）。
 * 余额为负（透支 / 欠款）用红色 text-expense，为正（有钱）用绿色 text-income，
 * 零值走 muted（既不"有钱"也不"欠钱"，不渲染情绪色）。
 */
export function balanceToneClass(balance: number): string {
  if (balance < 0) return 'text-expense';
  if (balance > 0) return 'text-income';
  return 'text-text-muted dark:text-text-muted-dark';
}

/** 饼图 / 环图系列配色（dashboard / reports / transactions 共用一份） */
export const PIE_COLORS = [
  '#10b981',
  '#6366f1',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#a3e635',
  '#f43f5e',
];
