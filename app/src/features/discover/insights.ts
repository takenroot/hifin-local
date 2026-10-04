/**
 * 发现页 — 数据洞察纯计算（不访问 Dexie，便于测试）
 *
 * formatMoney 已收敛到 @/lib/format，这里仅 re-export 以保持既有 import 路径不变。
 */
import dayjs from 'dayjs';
import type { Budget, Category, Goal, Transaction } from '@/db';

export { formatMoney } from '@/lib/format';

export function sumByType(
  txs: Transaction[],
  type: 'income' | 'expense',
  from: number,
  to: number,
): number {
  return txs
    .filter((t) => t.type === type && t.includeInAsset && t.date >= from && t.date < to)
    .reduce((s, t) => s + t.amount, 0);
}

/** 环比百分比；上期为 0 时返回 null */
export function monthOverMonth(cur: number, prev: number): number | null {
  if (prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

/** 单笔最大支出 */
export function largestExpense(txs: Transaction[]): Transaction | null {
  const list = txs.filter((t) => t.type === 'expense');
  if (list.length === 0) return null;
  return list.reduce((a, b) => (a.amount >= b.amount ? a : b));
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
  txs: Transaction[],
  categories: Category[],
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

/** 连续记账天数：从今天（或昨天）往前推，有流水（不含 excluded）即算一天 */
export function streakDays(txs: Transaction[], now: dayjs.Dayjs = dayjs()): number {
  const days = new Set<string>();
  for (const t of txs) {
    if (t.type === 'excluded') continue;
    days.add(dayjs(t.date).format('YYYY-MM-DD'));
  }
  let cursor = now.startOf('day');
  // 今天还没记账不算断签，从昨天开始数
  if (!days.has(cursor.format('YYYY-MM-DD'))) {
    cursor = cursor.subtract(1, 'day');
  }
  let streak = 0;
  while (days.has(cursor.format('YYYY-MM-DD'))) {
    streak += 1;
    cursor = cursor.subtract(1, 'day');
  }
  return streak;
}

export interface BudgetAlert {
  budget: Budget;
  spent: number;
  pct: number; // 可能 >100
}

/** 预算用量提醒：仅返回 pct >= threshold 的（默认 90%） */
export function budgetAlerts(
  budgets: Budget[],
  txs: Transaction[],
  threshold = 90,
  at: Date = new Date(),
): BudgetAlert[] {
  const out: BudgetAlert[] = [];
  for (const b of budgets) {
    const { from, to } = periodRangeOf(b.period, at);
    const spent = txs
      .filter(
        (t) =>
          t.type === 'expense' &&
          t.date >= from &&
          t.date < to &&
          (b.categoryId == null || t.categoryId === b.categoryId),
      )
      .reduce((s, t) => s + t.amount, 0);
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    if (pct >= threshold) out.push({ budget: b, spent, pct });
  }
  return out.sort((a, b) => b.pct - a.pct);
}

function periodRangeOf(period: 'monthly' | 'yearly', at: Date): { from: number; to: number } {
  const y = at.getFullYear();
  const m = at.getMonth();
  if (period === 'monthly') {
    return { from: new Date(y, m, 1).getTime(), to: new Date(y, m + 1, 1).getTime() };
  }
  return { from: new Date(y, 0, 1).getTime(), to: new Date(y + 1, 0, 1).getTime() };
}

/** 30 天内截止的未完成目标，按截止日升序 */
export function upcomingGoals(goals: Goal[], withinDays = 30, now: dayjs.Dayjs = dayjs()): Goal[] {
  const limit = now.add(withinDays, 'day').endOf('day').valueOf();
  return goals
    .filter(
      (g) =>
        g.deadline != null &&
        g.deadline <= limit &&
        g.deadline >= now.startOf('day').valueOf() &&
        g.currentAmount < g.targetAmount,
    )
    .sort((a, b) => (a.deadline ?? 0) - (b.deadline ?? 0));
}
