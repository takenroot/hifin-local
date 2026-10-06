/**
 * 月度聚合纯函数（看板/实验室统一聚合层）
 * ---------------------------------------------------------------
 * 2026-10-06 从 features/lab/labData.ts 上移到本模块——生产看板（/home）也
 * 需要这些聚合口径（12 月序列/30 天序列/储蓄率序列），把它收敛到 lib 避免
 * "生产页面 import lab 模块"的依赖倒置。
 *
 * 铁规：纯函数无 IO，无 React 依赖；可单测、可在 server 复用。
 *
 * ponytail: labData.ts 仍保留 export * re-export，老的 import 路径
 * '@/features/lab/labData' 继续生效，避免一次性改 3+ 处现有引用。
 */
import type { LabMonthlyPoint } from '@/features/lab/DashboardLab';

/* ── REST 行最小形状（不耦合全局 db 类型；看板/实验室共用一份最小形状） ── */

export interface TxRow {
  date: number; // ms
  amount: number;
  type: 'income' | 'expense' | 'transfer' | 'excluded';
  name: string;
  categoryId?: number | null;
  accountId?: number | null;
}

export interface AccountRow {
  name: string;
  balance: number;
  includeInNetAsset?: number;
}

export interface GoalRow {
  name: string;
  currentAmount: number;
  targetAmount: number;
}

export interface SummaryRow {
  netAsset: number;
  monthIncome: number;
  monthExpense: number;
  mom?: { deltaPct?: number } | null;
}

/* ── 月份工具 ── */

/** YYYY-MM（本地时区） */
export function monthKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** YYYY-MM-DD（本地时区） */
export function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  return `${monthKeyOf(ms)}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 最近 12 个月的 YYYY-MM 标签（旧→新，含 now 当月） */
export function last12MonthKeys(nowMs: number): string[] {
  const out: string[] = [];
  const d = new Date(nowMs);
  d.setDate(1);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
    out.push(`${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** 最近 n 天的 YYYY-MM-DD（旧→新，含今天） */
export function lastNDayKeys(nowMs: number, days: number): string[] {
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push(dateKeyOf(nowMs - i * 86400000));
  }
  return out;
}

/* ── 交易聚合 ── */

/**
 * 12 个月收支序列：transfers/excluded 不计；每月 balance = income - expense。
 * 与 mock genLabMonthly 同构（末月=当月），无交易的月份补零。
 */
export function toMonthlyPoints(txs: TxRow[], nowMs: number): LabMonthlyPoint[] {
  const keys = last12MonthKeys(nowMs);
  const sums = new Map<string, { income: number; expense: number }>(
    keys.map((k) => [k, { income: 0, expense: 0 }]),
  );
  for (const t of txs) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const k = monthKeyOf(t.date);
    const bucket = sums.get(k);
    if (!bucket) continue; // 12 个月窗口外的流水不影响
    if (t.type === 'income') bucket.income += t.amount;
    else bucket.expense += t.amount;
  }
  return keys.map((month) => {
    const { income, expense } = sums.get(month)!;
    return { month, income, expense, balance: income - expense };
  });
}

/**
 * 30 天净资产日序列：日净额（收-支）累加，末点锚定 summary 的 netAsset。
 * 与 mock genLabTrend 同形（{date, value}，date=YYYY-MM-DD）。
 */
export function toDailyNetSeries(
  txs: TxRow[],
  netAsset: number,
  nowMs: number,
  days = 30,
): Array<{ date: string; value: number }> {
  const keys = lastNDayKeys(nowMs, days);
  const netByDay = new Map<string, number>(keys.map((k) => [k, 0]));
  for (const t of txs) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const k = dateKeyOf(t.date);
    if (!netByDay.has(k)) continue;
    netByDay.set(k, netByDay.get(k)! + (t.type === 'income' ? t.amount : -t.amount));
  }
  const totalNet = keys.reduce((acc, k) => acc + netByDay.get(k)!, 0);
  // 锚定：首日前身 = 当前净资产 - 窗口内净额，逐日累加后末点恰好 = netAsset
  let running = netAsset - totalNet;
  return keys.map((date) => {
    running += netByDay.get(date)!;
    return { date, value: Math.round(running * 100) / 100 };
  });
}

/** 12 个月净资产月序列：把 monthly balance 累加、末点锚定 netAsset（sparkline 用） */
export function toNetAssetMonthlySeries(
  monthly: LabMonthlyPoint[],
  netAsset: number,
): Array<{ month: string; value: number }> {
  const totalBalance = monthly.reduce((acc, p) => acc + p.balance, 0);
  let running = netAsset - totalBalance;
  return monthly.map((p) => {
    running += p.balance;
    return { month: p.month, value: Math.round(running * 100) / 100 };
  });
}

/** 储蓄率序列：balance / income * 100；收入为 0 的月份记 0（除零守卫） */
export function toSavingsRateSeries(
  monthly: LabMonthlyPoint[],
): Array<{ month: string; value: number }> {
  return monthly.map((p) => ({
    month: p.month,
    value: p.income > 0 ? Math.round(((p.income - p.expense) / p.income) * 10000) / 100 : 0,
  }));
}

/* ── 卡片/列表映射 ── */

export interface LabStatShape {
  amount: number;
  deltaPct: number;
}

/**
 * 三卡 + 储蓄率的统计形状（label/tone 由页面定，这里只管数字）。
 * 环比口径：净资产用 summary.mom；收入/支出用 monthly 末月 vs 前月；
 * 储蓄率同理。上月基数为 0 时 delta 记 0（不产生 Infinity）。
 */
export function toLabStats(
  summary: SummaryRow,
  monthly: LabMonthlyPoint[],
): { netAsset: LabStatShape; income: LabStatShape; expense: LabStatShape; savings: LabStatShape } {
  const pct = (cur: number, prev: number): number =>
    prev > 0 ? Math.round(((cur - prev) / prev) * 10000) / 100 : 0;
  const last = monthly[monthly.length - 1];
  const prev = monthly[monthly.length - 2] ?? last;

  const savingsRate = (p: LabMonthlyPoint): number =>
    p.income > 0 ? ((p.income - p.expense) / p.income) * 100 : 0;

  return {
    netAsset: {
      amount: summary.netAsset,
      deltaPct: Math.round((summary.mom?.deltaPct ?? 0) * 100) / 100,
    },
    income: { amount: summary.monthIncome, deltaPct: pct(last.income, prev.income) },
    expense: { amount: summary.monthExpense, deltaPct: pct(last.expense, prev.expense) },
    savings: {
      amount: Math.round(savingsRate(last) * 100) / 100,
      deltaPct: Math.round((savingsRate(last) - savingsRate(prev)) * 100) / 100,
    },
  };
}

/** 资产分布切片：只纳入计入净资产且余额为正的账户（负债/零余额不画出负扇区） */
export function toSlices(accounts: AccountRow[]): Array<{ name: string; value: number }> {
  return accounts
    .filter((a) => a.includeInNetAsset !== 0 && a.balance > 0)
    .map((a) => ({ name: a.name, value: a.balance }));
}