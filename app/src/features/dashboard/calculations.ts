/**
 * 看板数据计算聚合（仅供 dashboard 模块内部使用）
 */
import dayjs from 'dayjs';
import type { Account, Transaction } from '@/db';

/** 净资产：includeInNetAsset=true 的资产类账户余额 - 负债类(credit/debt)余额 */
export function calcNetAsset(accounts: Account[]): number {
  let asset = 0;
  let debt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') {
      // 负债余额：通常账户余额以"未还金额"或"额度"形式存在，统一视为负债正值
      debt += Math.abs(a.balance);
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