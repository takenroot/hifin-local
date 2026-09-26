/**
 * 余额联动 + 过滤/聚合工具
 * ---------------------------------------------------------------
 * 这一模块只依赖 Dexie db + types，不依赖 UI 组件。
 */
import dayjs from 'dayjs';
import type { Transaction, TransactionType } from '@/db';

/**
 * 一笔交易对账户余额的影响（不含 includeInAsset 维度——账户余额
 * 永远跟随实际收支变化，资产汇总的"是否计入净资产"是另一层语义）。
 *
 *  - expense    accountId -= amount
 *  - income     accountId += amount
 *  - transfer   accountId -= amount ; toAccountId += amount
 *  - excluded   不影响账户余额
 */
export interface AccountDelta {
  accountId: number;
  delta: number;
}

export function deltasOf(tx: Transaction): AccountDelta[] {
  if (tx.type === 'excluded') return [];
  const out: AccountDelta[] = [];
  if (tx.type === 'expense') {
    out.push({ accountId: tx.accountId, delta: -tx.amount });
  } else if (tx.type === 'income') {
    out.push({ accountId: tx.accountId, delta: tx.amount });
  } else if (tx.type === 'transfer') {
    if (!tx.toAccountId) return out;
    if (tx.toAccountId === tx.accountId) return out;
    out.push({ accountId: tx.accountId, delta: -tx.amount });
    out.push({ accountId: tx.toAccountId, delta: tx.amount });
  }
  return out;
}

/** 类型 / 分类 / 账户 / 日期范围过滤 */
export interface TxFilter {
  types?: TransactionType[];
  categoryId?: number;
  accountId?: number;
  from?: number; // 含
  to?: number; // 含
}

export function applyFilter(
  list: Transaction[],
  filter: TxFilter,
): Transaction[] {
  return list.filter((t) => {
    if (filter.types && filter.types.length > 0 && !filter.types.includes(t.type)) {
      return false;
    }
    if (filter.categoryId && t.categoryId !== filter.categoryId) return false;
    if (filter.accountId) {
      if (t.accountId !== filter.accountId && t.toAccountId !== filter.accountId) return false;
    }
    if (filter.from !== undefined && t.date < filter.from) return false;
    if (filter.to !== undefined && t.date > filter.to) return false;
    return true;
  });
}

/** 汇总：收入 / 支出 / 净流（不计 transfer / excluded） */
export interface TxSummary {
  income: number;
  expense: number;
  transfer: number; // 仅用于显示
  count: number;
}

export function summarize(list: Transaction[]): TxSummary {
  let income = 0;
  let expense = 0;
  let transfer = 0;
  for (const t of list) {
    if (t.type === 'income') income += t.amount;
    else if (t.type === 'expense') expense += t.amount;
    else if (t.type === 'transfer') transfer += t.amount;
  }
  return { income, expense, transfer, count: list.length };
}

/** 月份范围 [start, end) */
export function monthRange(month: dayjs.Dayjs): { from: number; to: number } {
  const start = month.startOf('month');
  const end = month.add(1, 'month').startOf('month');
  return { from: start.valueOf(), to: end.valueOf() };
}
