/**
 * AI 洞察月度指标聚合 — 喂给 LLM 的结构化数据源。
 *
 * 输入：目标月份（YYYY-MM）。
 * 输出：MonthMetrics：收入/支出/净收支/MoM/TOP 分类/异常大额/预算告警/临近目标 等。
 *
 * 复用 summary.ts 的 monthRange / previousMonth：monthRange 已经是 summaryHelpers 的一部分，
 * 跨包再写一遍就是复制粘贴——这里直接 import 过来用。
 *
 * 多空间：当前实现只查 spaceId=1（与设计文档一致）；v2 再加 ?spaceId 参数。
 */
import type Database from 'better-sqlite3';
import type {
  BudgetRow,
  CategoryRow,
  GoalRow,
  TransactionRow,
} from '../db/schema.js';
import { summaryHelpers } from '../routes/summary.js';
import {
  budgetAlerts,
  largestExpense,
  monthOverMonth,
  topCategories,
  upcomingGoals,
  type CategoryRank,
} from './math.js';

export interface MonthMetrics {
  /** 目标月份 YYYY-MM */
  month: string;
  income: number;
  expense: number;
  /** 收入 - 支出 */
  net: number;
  /** 净收支环比（百分比）；上月为 0 时为 null */
  momPct: number | null;
  /** 支出 TOP 3 分类（含百分比） */
  topExpense: CategoryRank[];
  /** 分类环比 TOP 5（this vs prev），用于发现「某分类突然涨了 200%」类异常 */
  topExpenseMom: Array<{
    categoryId: number;
    name: string;
    icon: string;
    this: number;
    prev: number;
    deltaPct: number | null;
  }>;
  /** 单笔最大支出 */
  largest: { name: string; amount: number; date: number } | null;
  /** 预算 >= 80% 的告警（含超 100% 的） */
  budgetAlerts: Array<{
    name: string;
    spent: number;
    amount: number;
    pct: number;
  }>;
  /** 30 天内截止的未完成目标 */
  goalsNear: Array<{
    id?: number;
    name: string;
    deadline: number;
    currentAmount: number;
    targetAmount: number;
  }>;
  /** 异常大额：单笔支出 > 月均支出 × 5 */
  anomalyLarge: Array<{
    name: string;
    amount: number;
    date: number;
    ratioToAvg: number;
  }>;
}

export interface ComputeOptions {
  /** 预算告警阈值（百分比），默认 80。设计文档要求比 discover 的 90 更敏感 */
  budgetThreshold?: number;
  /** 异常大额倍数（默认 5） */
  anomalyMultiple?: number;
  /** 「30 天内到期」用 now 入参（默认 Date.now()） */
  nowMs?: number;
}

/**
 * 聚合目标月份 + 上一月的指标。纯函数：只读 db，不写。
 *
 * ⚠️ 月份解析失败返回 null：调用方应先在 REST 层 / 调度层校验 YYYY-MM。
 * 与 summary.ts 不同，这里 monthRange 拿 null 时直接返回 null（让上层决定是 400 还是其它）。
 */
function previousMonth(monthStr: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) return monthStr;
  let year = Number(m[1]);
  let mo = Number(m[2]);
  mo -= 1;
  if (mo === 0) {
    mo = 12;
    year -= 1;
  }
  return `${year}-${String(mo).padStart(2, '0')}`;
}

export function computeMonthMetrics(
  db: Database.Database,
  month: string,
  opts: ComputeOptions = {},
): MonthMetrics | null {
  const range = summaryHelpers.monthRange(month);
  if (range === null) return null;
  const prev = previousMonth(month);
  const prevRange = summaryHelpers.monthRange(prev);
  if (prevRange === null) return null;

  // 同 SQL：v1 只看默认空间
  const transactions = db
    .prepare('SELECT * FROM transactions WHERE spaceId = 1 AND date >= ? AND date < ?')
    .all(range.start, range.end) as TransactionRow[];
  const prevTransactions = db
    .prepare('SELECT * FROM transactions WHERE spaceId = 1 AND date >= ? AND date < ?')
    .all(prevRange.start, prevRange.end) as TransactionRow[];
  const budgets = db
    .prepare('SELECT * FROM budgets WHERE spaceId = 1')
    .all() as BudgetRow[];
  const goals = db.prepare('SELECT * FROM goals WHERE spaceId = 1').all() as GoalRow[];
  const categories = db.prepare('SELECT * FROM categories').all() as CategoryRow[];

  const expenseTxs = transactions.filter(
    (t) => t.type === 'expense' && t.includeInAsset,
  );
  const income = transactions
    .filter((t) => t.type === 'income' && t.includeInAsset)
    .reduce((s, t) => s + t.amount, 0);
  const expense = expenseTxs.reduce((s, t) => s + t.amount, 0);

  const prevExpenseTxs = prevTransactions.filter(
    (t) => t.type === 'expense' && t.includeInAsset,
  );
  const prevIncome = prevTransactions
    .filter((t) => t.type === 'income' && t.includeInAsset)
    .reduce((s, t) => s + t.amount, 0);
  const prevExpense = prevExpenseTxs.reduce((s, t) => s + t.amount, 0);

  // 分类环比：合并本月与上月的分类 sum，按 this - prev 排序
  const byCatNow = new Map<number, number>();
  for (const t of expenseTxs) {
    byCatNow.set(t.categoryId ?? -1, (byCatNow.get(t.categoryId ?? -1) ?? 0) + t.amount);
  }
  const byCatPrev = new Map<number, number>();
  for (const t of prevExpenseTxs) {
    byCatPrev.set(t.categoryId ?? -1, (byCatPrev.get(t.categoryId ?? -1) ?? 0) + t.amount);
  }
  const allCatIds = new Set<number>([...byCatNow.keys(), ...byCatPrev.keys()]);
  const topExpenseMom = [...allCatIds]
    .map((cid) => {
      const cat = categories.find((c) => c.id === cid);
      const thisAmt = byCatNow.get(cid) ?? 0;
      const prevAmt = byCatPrev.get(cid) ?? 0;
      const delta = thisAmt - prevAmt;
      const deltaPct = prevAmt > 0 ? (delta / prevAmt) * 100 : thisAmt > 0 ? null : 0;
      return {
        categoryId: cid,
        name: cat?.name ?? '未分类',
        icon: cat?.icon ?? '📦',
        this: thisAmt,
        prev: prevAmt,
        deltaPct,
      };
    })
    .sort((a, b) => Math.abs(b.deltaPct ?? 0) - Math.abs(a.deltaPct ?? 0))
    .slice(0, 5);

  const topExpense = topCategories(
    transactions,
    categories,
    range.start,
    range.end,
    3,
  );
  const largest = largestExpense(expenseTxs);
  const threshold = opts.budgetThreshold ?? 80;
  const alerts = budgetAlerts(budgets, transactions, threshold, new Date(range.start));
  const goalsNear = upcomingGoals(goals, 30, opts.nowMs ?? Date.now());
  const anomalyMultiple = opts.anomalyMultiple ?? 5;
  const avgPerTx = expenseTxs.length > 0 ? expense / expenseTxs.length : 0;
  const anomalyLarge = expenseTxs
    .filter((t) => t.amount > avgPerTx * anomalyMultiple)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5)
    .map((t) => ({
      name: t.name,
      amount: t.amount,
      date: t.date,
      ratioToAvg: avgPerTx > 0 ? t.amount / avgPerTx : 0,
    }));

  return {
    month,
    income,
    expense,
    net: income - expense,
    momPct: monthOverMonth(income - expense, prevIncome - prevExpense),
    topExpense,
    topExpenseMom,
    largest: largest
      ? { name: largest.name, amount: largest.amount, date: largest.date }
      : null,
    budgetAlerts: alerts.map((a) => ({
      name: a.budget.name,
      spent: a.spent,
      amount: a.budget.amount,
      pct: a.pct,
    })),
    goalsNear: goalsNear.map((g) => ({
      id: g.id,
      name: g.name,
      deadline: g.deadline as number,
      currentAmount: g.currentAmount,
      targetAmount: g.targetAmount,
    })),
    anomalyLarge,
  };
}