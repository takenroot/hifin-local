/**
 * 看板数据计算聚合（仅供 dashboard 模块内部使用）
 */
import dayjs from 'dayjs';
import type { Account, Budget, Transaction } from '@/db';
import { periodRange } from '@/features/budget/format';

/**
 * 净资产：includeInNetAsset=true 的资产类账户余额 - 负债类(credit/debt)余额
 *
 * 负债账户(credit/debt)的余额符号约定与资产账户一致——余额为负才是负债：
 *   负余额（欠款）→ 记正负债；正余额（多还/退款在途）→ 记负负债，即算资产。
 * 曾经用 Math.abs，会把花呗这类"多还了钱"的正余额当欠款，净资产凭空少 2×该金额。
 */
export function calcNetAsset(accounts: Account[]): number {
  let asset = 0;
  let debt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') {
      debt += -a.balance;
    } else {
      asset += a.balance;
    }
  }
  return asset - debt;
}

/** 指定月份范围 [start, end) 内收入合计（includeInAsset=true） */
export function sumIncome(transactions: Transaction[], start: number, end: number): number {
  let sum = 0;
  for (const t of transactions) {
    if (t.type !== 'income') continue;
    if (t.includeInAsset === false) continue;
    if (t.date >= start && t.date < end) sum += t.amount;
  }
  return sum;
}

/** 指定月份范围 [start, end) 内支出合计（includeInAsset=true） */
export function sumExpense(transactions: Transaction[], start: number, end: number): number {
  let sum = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (t.includeInAsset === false) continue;
    if (t.date >= start && t.date < end) sum += t.amount;
  }
  return sum;
}

/**
 * 净资产按天回推估算：
 *   - 以当前净资产为锚点；逐日减去当日影响净资产的"净额"得到当日净资产
 *   - 影响 = 收入 − 支出（排除 transfer、excluded）
 *   - 近 N 天（默认 30）返回 [{ date: 'YYYY-MM-DD', value: number }]
 */
export function netAssetTrend(
  accounts: Account[],
  transactions: Transaction[],
  days = 30,
): Array<{ date: string; value: number }> {
  const today = dayjs().endOf('day');
  const start = today.subtract(days - 1, 'day').startOf('day');
  const currentNet = calcNetAsset(accounts);

  // 先收集每日净额
  const dailyDelta = new Map<string, number>();
  for (const t of transactions) {
    if (t.type === 'transfer' || t.type === 'excluded') continue;
    if (t.includeInAsset === false) continue;
    const day = dayjs(t.date).format('YYYY-MM-DD');
    const delta = t.type === 'income' ? t.amount : t.amount; // expense will subtract
    const prev = dailyDelta.get(day) ?? 0;
    dailyDelta.set(day, prev + delta * (t.type === 'income' ? 1 : -1));
  }

  let running = currentNet;
  // 从今天倒推
  const cache: Array<{ date: string; value: number }> = [];
  for (let i = 0; i < days; i++) {
    const d = today.subtract(i, 'day');
    const key = d.format('YYYY-MM-DD');
    cache.push({ date: key, value: running });
    // 下一天 = 今天 - 当天的净额
    const delta = dailyDelta.get(key) ?? 0;
    running -= delta;
  }
  // 倒序为时间正序
  return cache.reverse().filter((r) => dayjs(r.date).isAfter(start.subtract(1, 'day')));
}

/** 资产分布（按账户） */
export function distributionByAccount(accounts: Account[]): Array<{ name: string; value: number }> {
  return accounts
    .filter((a) => a.includeInNetAsset && a.type !== 'credit' && a.type !== 'debt' && a.balance > 0)
    .map((a) => ({ name: a.name, value: a.balance }));
}

/** 资产分布（按"交易方式"——即账户 type） */
export function distributionByAccountType(accounts: Account[]): Array<{ name: string; value: number }> {
  const buckets = new Map<string, number>();
  const labels: Record<string, string> = {
    fund: '资金',
    asset: '资产',
    social: '社保',
    invest: '投资',
    other: '其他',
  };
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') continue;
    if (a.balance <= 0) continue;
    const key = labels[a.type] ?? '其他';
    buckets.set(key, (buckets.get(key) ?? 0) + a.balance);
  }
  return Array.from(buckets.entries()).map(([name, value]) => ({ name, value }));
}

/** 资产分布的分组口径 */
export type DistributionMode = 'account' | 'type';

/**
 * 资产分布 + "没画进去的部分"的对账信息。
 *
 * 为什么要单独返回后两项
 * -----------------------------------------------------------------
 * 饼图画不了负数，所以 distributionBy* 只收正余额的资产账户。多账户之前
 * 这没什么问题（就一两个账户，余额基本为正）；分流成 7 个账户之后就不行了：
 * 花呗还款是从银行卡里扣钱走的，银行卡很可能被扣成负数，于是它会**静默
 * 消失**在资产分布里——用户看到饼图比净资产大，却找不到少掉的钱去哪了。
 *
 * 所以这里把"因为是负数 / 是负债而没进饼图"的金额一并算出来交给 UI 显式
 * 说明。宁可多一行小字，也不要让用户对不上账。
 */
export interface DistributionBreakdown {
  /** 画进饼图的份额（恒为正数） */
  items: Array<{ name: string; value: number }>;
  /** 没进饼图的负余额资产账户合计（负数） */
  excludedNegative: number;
  /** 没进饼图的负债账户合计（负数，取绝对值展示由 UI 决定） */
  excludedDebt: number;
}

/** 资产/负债的判定：与账户列表页的分组口径保持一致 */
export function isDebtAccount(a: Account): boolean {
  return a.type === 'credit' || a.type === 'debt';
}

/**
 * 算出资产分布，并同时给出"没画进去的钱"。
 *
 * 与 distributionByAccount/ByAccountType 的差异只有一处：额外返回被排除的
 * 负值与负债金额。饼图数据本身逐项一致，所以换用本函数不会改变图形。
 */
export function buildDistribution(accounts: Account[], mode: DistributionMode): DistributionBreakdown {
  const items = mode === 'account' ? distributionByAccount(accounts) : distributionByAccountType(accounts);
  let excludedNegative = 0;
  let excludedDebt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (isDebtAccount(a)) {
      // 负债一律不进"资产分布"，但金额要报出来
      excludedDebt += a.balance;
      continue;
    }
    if (a.balance < 0) excludedNegative += a.balance;
  }
  return { items, excludedNegative, excludedDebt };
}

/** 月内日历数据：按日聚合收入/支出 */
export interface CalendarDay {
  date: dayjs.Dayjs;
  income: number;
  expense: number;
  count: number;
}
export function buildCalendar(transactions: Transaction[], month: dayjs.Dayjs): CalendarDay[] {
  const start = month.startOf('month');
  const daysInMonth = month.daysInMonth();
  const map = new Map<string, { income: number; expense: number; count: number }>();
  for (const t of transactions) {
    if (t.type === 'transfer' || t.type === 'excluded') continue;
    const day = dayjs(t.date).startOf('day');
    if (day.month() !== month.month() || day.year() !== month.year()) continue;
    const key = day.format('YYYY-MM-DD');
    const cur = map.get(key) ?? { income: 0, expense: 0, count: 0 };
    if (t.type === 'income') cur.income += t.amount;
    else if (t.type === 'expense') cur.expense += t.amount;
    cur.count += 1;
    map.set(key, cur);
  }
  const result: CalendarDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = start.add(i, 'day');
    const key = d.format('YYYY-MM-DD');
    const cur = map.get(key);
    result.push({
      date: d,
      income: cur?.income ?? 0,
      expense: cur?.expense ?? 0,
      count: cur?.count ?? 0,
    });
  }
  return result;
}

/** 当月某日交易列表 */
export function transactionsOnDay(
  transactions: Transaction[],
  day: dayjs.Dayjs,
): Transaction[] {
  const start = day.startOf('day').valueOf();
  const end = day.endOf('day').valueOf();
  return transactions
    .filter((t) => t.date >= start && t.date <= end)
    .sort((a, b) => b.date - a.date);
}

/** 单个预算的本期进度（看板预算卡渲染用） */
export interface BudgetProgress {
  budget: Budget;
  /** 本期已花（只算支出） */
  spent: number;
  /** 已用百分比，amount<=0 时为 0（不做除零） */
  pct: number;
  /** 是否超支（amount>0 且已花超过额度） */
  overspent: boolean;
}

/**
 * 预算卡进度：按每个预算**自身周期**在本地聚合"本期已花"。
 *
 * core 没有 budget-spent 端点，所以和 /budget 页是同一套算法：复用预算模块的
 * periodRange（monthly=当前自然月、yearly=当前自然年），只累加 type='expense'，
 * categoryId 非空时再按分类过滤（null = 总预算，统计全部支出）。
 * at 显式传入是为了让"本月/本年"在测试里可复现。
 */
export function buildBudgetProgress(
  budgets: Budget[],
  transactions: Transaction[],
  at: Date = new Date(),
): BudgetProgress[] {
  return budgets.map((b) => {
    const { from, to } = periodRange(b.period, at);
    let spent = 0;
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      if (t.date < from || t.date >= to) continue;
      if (b.categoryId != null && t.categoryId !== b.categoryId) continue;
      spent += t.amount;
    }
    const pct = b.amount > 0 ? (spent / b.amount) * 100 : 0;
    return { budget: b, spent, pct, overspent: b.amount > 0 && spent > b.amount };
  });
}