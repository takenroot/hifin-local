/**
 * 报表数据计算聚合（仅供 reports 模块内部使用）。
 */
import dayjs from 'dayjs';
import type { Account, Goal, Transaction } from '@/db';

/* ───────────────────── 账户类型分布 ───────────────────── */

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  fund: '资金',
  asset: '资产',
  social: '社保',
  invest: '投资',
  other: '其他',
};

export interface DistributionDatum {
  name: string;
  /** 外部唯一 key */
  key: string;
  value: number;
  pct: number;
  /** 仅作展示；按 type 维度时携带主色调 */
  accent?: string;
}

/** 按账户分布：includeInNetAsset=true 且余额 > 0 的"非信用/非债务"账户 */
export function distributionByAccount(accounts: Account[]): DistributionDatum[] {
  const total = accounts
    .filter(
      (a) =>
        a.includeInNetAsset &&
        a.type !== 'credit' &&
        a.type !== 'debt' &&
        a.balance > 0,
    )
    .reduce((s, a) => s + a.balance, 0);
  const items = accounts
    .filter(
      (a) =>
        a.includeInNetAsset &&
        a.type !== 'credit' &&
        a.type !== 'debt' &&
        a.balance > 0,
    )
    .map((a) => ({
      name: a.name,
      key: `acc-${a.id ?? a.name}`,
      value: a.balance,
      pct: total > 0 ? (a.balance / total) * 100 : 0,
    }));
  return items.sort((a, b) => b.value - a.value);
}

/** 按"账户类型"分布（资金 / 资产 / 社保 / 投资 / 其他） */
export function distributionByType(accounts: Account[]): DistributionDatum[] {
  const buckets = new Map<string, number>();
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') continue;
    if (a.balance <= 0) continue;
    const label = ACCOUNT_TYPE_LABELS[a.type] ?? '其他';
    buckets.set(label, (buckets.get(label) ?? 0) + a.balance);
  }
  const total = Array.from(buckets.values()).reduce((s, v) => s + v, 0);
  return Array.from(buckets.entries())
    .map(([name, value]) => ({
      name,
      key: `type-${name}`,
      value,
      pct: total > 0 ? (value / total) * 100 : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

/* ───────────────────── 月度收支（近 12 月） ───────────────────── */

export interface MonthlyDatum {
  /** yyyy-MM */
  key: string;
  label: string; // '1月' / 'Jan 24'
  income: number;
  expense: number;
  net: number;
}

export function monthly12(transactions: Transaction[]): MonthlyDatum[] {
  const today = dayjs();
  const months: MonthlyDatum[] = [];
  for (let i = 11; i >= 0; i--) {
    const m = today.subtract(i, 'month');
    const start = m.startOf('month').valueOf();
    const end = m.add(1, 'month').startOf('month').valueOf();
    let income = 0;
    let expense = 0;
    for (const t of transactions) {
      if (t.date < start || t.date >= end) continue;
      if (t.includeInAsset === false) continue;
      if (t.type === 'income') income += t.amount;
      else if (t.type === 'expense') expense += t.amount;
    }
    months.push({
      key: m.format('YYYY-MM'),
      label: `${m.month() + 1}月`,
      income,
      expense,
      net: income - expense,
    });
  }
  return months;
}

/* ───────────────────── 当年年度总结 ───────────────────── */

export interface YearlySummary {
  year: number;
  income: number;
  expense: number;
  net: number;
  transactionCount: number;
}

export function yearlySummary(transactions: Transaction[]): YearlySummary {
  const year = dayjs().year();
  const start = dayjs().startOf('year').valueOf();
  const end = start + 365 * 24 * 60 * 60 * 1000; // 简化处理跨年仍属本年
  let income = 0;
  let expense = 0;
  let count = 0;
  for (const t of transactions) {
    if (t.date < start || t.date >= end) continue;
    if (t.includeInAsset === false) continue;
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
    count++;
  }
  return { year, income, expense, net: income - expense, transactionCount: count };
}

/* ───────────────────── 净资产估算 ───────────────────── */

export function calcNetAsset(accounts: Account[]): number {
  let asset = 0;
  let debt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') {
      debt += Math.abs(a.balance);
    } else {
      asset += a.balance;
    }
  }
  return asset - debt;
}

/* ───────────────────── 目标进度（用于报告上下文） ───────────────────── */

export interface GoalProgressDatum {
  name: string;
  pct: number;
  current: number;
  target: number;
  kind: 'saving' | 'repayment';
}

export function summarizeGoals(goals: Goal[]): GoalProgressDatum[] {
  return goals.map((g) => ({
    name: g.name,
    pct:
      g.targetAmount > 0
        ? Math.min(100, (g.currentAmount / g.targetAmount) * 100)
        : 0,
    current: g.currentAmount,
    target: g.targetAmount,
    kind: g.kind,
  }));
}
