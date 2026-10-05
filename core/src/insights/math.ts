/**
 * 发现页 — 数据洞察的纯计算（移植自 app/src/features/discover/insights.ts）。
 *
 * 移植目的：core 不能 import app 的代码（app 依赖 @/db 与 dayjs），
 * 而 insights 的纯函数不需要任何 React / Dexie / dayjs 上下文。
 * 所以这里**逐字搬运**算法，只把 dayjs 换成原生 Date / 时间戳运算，
 * 签名随之微调（`upcomingGoals` 不再吃 dayjs.Dayjs，而是吃 `now: number`）。
 *
 * 字段命名沿用 {x:"TransactionRow"} 等 app 类型，与 core 的 TransactionRow 完全结构兼容。
 */
import type {
  BudgetRow,
  CategoryRow,
  GoalRow,
  TransactionRow,
} from '../db/schema.js';

export function sumByType(
  txs: TransactionRow[],
  type: 'income' | 'expense',
  from: number,
  to: number,
): number {
  let s = 0;
  for (const t of txs) {
    if (t.type !== type || !t.includeInAsset) continue;
    if (t.date >= from && t.date < to) s += t.amount;
  }
  return s;
}

/** 环比百分比；上期为 0 时返回 null */
export function monthOverMonth(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** 单笔最大支出 */
export function largestExpense(txs: TransactionRow[]): TransactionRow | null {
  let best: TransactionRow | null = null;
  for (const t of txs) {
    if (t.type !== 'expense') continue;
    if (best === null || t.amount > best.amount) best = t;
  }
  return best;
}

export interface CategoryRank {
  categoryId: number;
  name: string;
  icon: string;
  amount: number;
  pct: number; // 0-100
}

/** 支出 TOP N 分类（本月） */
export function topCategories(
  txs: TransactionRow[],
  categories: CategoryRow[],
  from: number,
  to: number,
  topN = 3,
): CategoryRank[] {
  const sums = new Map<number, number>();
  let total = 0;
  for (const t of txs) {
    if (t.type !== 'expense' || t.date < from || t.date >= to) continue;
    const key = t.categoryId ?? -1;
    sums.set(key, (sums.get(key) ?? 0) + t.amount);
    total += t.amount;
  }
  if (total === 0) return [];
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([categoryId, amount]) => {
      const cat = categories.find((c) => c.id === categoryId);
      return {
        categoryId,
        name: cat?.name ?? '未分类',
        icon: cat?.icon ?? '📦',
        amount,
        pct: (amount / total) * 100,
      };
    });
}

export interface BudgetAlert {
  budget: BudgetRow;
  spent: number;
  pct: number; // 可能 >100
}

/** 预算用量提醒：仅返回 pct >= threshold 的（默认 90%） */
export function budgetAlerts(
  budgets: BudgetRow[],
  txs: TransactionRow[],
  threshold = 90,
  at: Date = new Date(),
): BudgetAlert[] {
  const out: BudgetAlert[] = [];
  for (const b of budgets) {
    const { from, to } = periodRangeOf(b.period, at);
    let spent = 0;
    for (const t of txs) {
      if (t.type !== 'expense') continue;
      if (t.date < from || t.date >= to) continue;
      if (b.categoryId != null && t.categoryId !== b.categoryId) continue;
      spent += t.amount;
    }
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    if (pct >= threshold) out.push({ budget: b, spent, pct });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

function periodRangeOf(
  period: 'monthly' | 'yearly',
  at: Date,
): { from: number; to: number } {
  const y = at.getFullYear();
  const m = at.getMonth();
  if (period === 'monthly') {
    return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
  }
  return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
}

/**
 * 30 天内截止的未完成目标，按截止日升序。
 * `now` 用时间戳入参（与 yield-reminder 一脉相承的注入式时间），
 * 不再依赖 dayjs；"今天 00:00" 与"30 天后当天 23:59:59.999"同样用原生 Date 取。
 */
export function upcomingGoals(
  goals: GoalRow[],
  withinDays = 30,
  now: number = Date.now(),
): GoalRow[] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const limit = new Date(now);
  limit.setDate(limit.getDate() + withinDays);
  limit.setHours(23, 59, 59, 999);
  return goals
    .filter(
      (g) =>
        g.deadline != null &&
        g.deadline <= limit.getTime() &&
        g.deadline >= startOfToday.getTime() &&
        g.currentAmount < g.targetAmount,
    )
    .sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0));
}