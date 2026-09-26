import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { deltasOf, applyFilter, summarize, monthRange } from '@/features/transactions/balance';
import type { Transaction } from '@/db';

// ───────────── 工具：构造一笔测试用交易 ─────────────
function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    type: 'expense',
    name: '测试',
    amount: 100,
    date: Date.now(),
    accountId: 1,
    includeInAsset: true,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('deltasOf', () => {
  it('expense：从账户扣除', () => {
    const tx = makeTx({ type: 'expense', amount: 50, accountId: 1 });
    expect(deltasOf(tx)).toEqual([{ accountId: 1, delta: -50 }]);
  });

  it('income：向账户增加', () => {
    const tx = makeTx({ type: 'income', amount: 200, accountId: 2 });
    expect(deltasOf(tx)).toEqual([{ accountId: 2, delta: 200 }]);
  });

  it('transfer：从源账户扣除、向目标账户增加', () => {
    const tx = makeTx({ type: 'transfer', amount: 80, accountId: 1, toAccountId: 2 });
    expect(deltasOf(tx)).toEqual([
      { accountId: 1, delta: -80 },
      { accountId: 2, delta: 80 },
    ]);
  });

  it('transfer：同账户视为豁免，不产生 delta', () => {
    const tx = makeTx({ type: 'transfer', amount: 80, accountId: 1, toAccountId: 1 });
    expect(deltasOf(tx)).toEqual([]);
  });

  it('transfer：缺 toAccountId 时不产生 delta', () => {
    const tx = makeTx({ type: 'transfer', amount: 80, accountId: 1 });
    expect(deltasOf(tx)).toEqual([]);
  });

  it('excluded：不影响账户余额', () => {
    const tx = makeTx({ type: 'excluded', amount: 999, accountId: 3 });
    expect(deltasOf(tx)).toEqual([]);
  });
});

describe('applyFilter', () => {
  const txs: Transaction[] = [
    makeTx({ id: 1, type: 'expense', amount: 10, accountId: 1, categoryId: 5, date: 1000 }),
    makeTx({ id: 2, type: 'income', amount: 100, accountId: 1, categoryId: 6, date: 2000 }),
    makeTx({ id: 3, type: 'expense', amount: 20, accountId: 2, categoryId: 5, date: 3000 }),
    makeTx({ id: 4, type: 'transfer', amount: 30, accountId: 1, toAccountId: 2, date: 4000 }),
    makeTx({ id: 5, type: 'excluded', amount: 40, accountId: 1, date: 5000 }),
  ];

  it('按 type 过滤：仅支出', () => {
    const result = applyFilter(txs, { types: ['expense'] });
    expect(result.map((t) => t.id)).toEqual([1, 3]);
  });

  it('按 type 过滤：多类型', () => {
    const result = applyFilter(txs, { types: ['income', 'transfer'] });
    expect(result.map((t) => t.id)).toEqual([2, 4]);
  });

  it('按 categoryId 过滤', () => {
    const result = applyFilter(txs, { categoryId: 5 });
    expect(result.map((t) => t.id)).toEqual([1, 3]);
  });

  it('按 accountId 过滤：accountId 与 toAccountId 命中均保留', () => {
    const result = applyFilter(txs, { accountId: 2 });
    expect(result.map((t) => t.id)).toEqual([3, 4]);
  });

  it('按日期范围 [from, to] 闭区间过滤', () => {
    const result = applyFilter(txs, { from: 2000, to: 3000 });
    expect(result.map((t) => t.id)).toEqual([2, 3]);
  });

  it('组合过滤：仅支出 + 账户 1', () => {
    const result = applyFilter(txs, { types: ['expense'], accountId: 1 });
    expect(result.map((t) => t.id)).toEqual([1]);
  });

  it('空过滤条件：返回原列表', () => {
    expect(applyFilter(txs, {})).toHaveLength(5);
  });
});

describe('summarize', () => {
  it('分别汇总 income / expense / transfer / count', () => {
    const list: Transaction[] = [
      makeTx({ id: 1, type: 'income', amount: 100 }),
      makeTx({ id: 2, type: 'income', amount: 50 }),
      makeTx({ id: 3, type: 'expense', amount: 30 }),
      makeTx({ id: 4, type: 'transfer', amount: 40 }),
      makeTx({ id: 5, type: 'excluded', amount: 10 }),
    ];
    expect(summarize(list)).toEqual({ income: 150, expense: 30, transfer: 40, count: 5 });
  });

  it('空数组：全部为 0、count=0', () => {
    expect(summarize([])).toEqual({ income: 0, expense: 0, transfer: 0, count: 0 });
  });
});

describe('monthRange', () => {
  it('返回本月 [start, end) 的时间戳', () => {
    const month = dayjs('2024-03-15');
    const { from, to } = monthRange(month);
    expect(dayjs(from).format('YYYY-MM-DD')).toBe('2024-03-01');
    expect(dayjs(from).hour()).toBe(0);
    expect(dayjs(to).format('YYYY-MM-DD')).toBe('2024-04-01');
  });

  it('跨年：从 12 月到次年 1 月', () => {
    const month = dayjs('2024-12-20');
    const { from, to } = monthRange(month);
    expect(dayjs(from).format('YYYY-MM-DD HH:mm:ss')).toBe('2024-12-01 00:00:00');
    expect(dayjs(to).format('YYYY-MM-DD HH:mm:ss')).toBe('2025-01-01 00:00:00');
  });

  it('to 是 from 之下一月开始（半开区间）', () => {
    const { from, to } = monthRange(dayjs('2024-02-10'));
    expect(dayjs(to).diff(dayjs(from), 'day')).toBe(29); // 2024-02 是闰月
  });
});
