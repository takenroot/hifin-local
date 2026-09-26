import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  calcNetAsset,
  buildCalendar,
} from '@/features/dashboard/calculations';
import { monthOverMonth } from '@/features/dashboard/format';
import type { Account, Transaction } from '@/db';

function makeAccount(overrides: Partial<Account>): Account {
  return {
    id: 1,
    name: '测试账户',
    type: 'fund',
    balance: 0,
    includeInNetAsset: true,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeTx(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    type: 'expense',
    name: '测试',
    amount: 0,
    date: 0,
    accountId: 1,
    includeInAsset: true,
    createdAt: 0,
    ...overrides,
  };
}

describe('calcNetAsset', () => {
  it('简单资产负债口径：资产 - 负债', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 1000, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'asset', balance: 5000, includeInNetAsset: true }),
      makeAccount({ id: 3, type: 'credit', balance: 2000, includeInNetAsset: true }),
    ];
    expect(calcNetAsset(accounts)).toBe(1000 + 5000 - 2000);
  });

  it('includeInNetAsset=false 的账户被排除', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 1000, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'fund', balance: 9999, includeInNetAsset: false }),
    ];
    expect(calcNetAsset(accounts)).toBe(1000);
  });

  it('credit/debt 余额按绝对值计入负债', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'credit', balance: -1500, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'debt', balance: 3000, includeInNetAsset: true }),
    ];
    expect(calcNetAsset(accounts)).toBe(-(1500 + 3000));
  });

  it('空数组：净资产为 0', () => {
    expect(calcNetAsset([])).toBe(0);
  });

  it('所有账户均不计入：净资产为 0', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 1000, includeInNetAsset: false }),
    ];
    expect(calcNetAsset(accounts)).toBe(0);
  });
});

describe('monthOverMonth', () => {
  it('正常环比：正增长', () => {
    expect(monthOverMonth(120, 100)).toBeCloseTo(20, 5);
  });

  it('正常环比：负增长', () => {
    expect(monthOverMonth(80, 100)).toBeCloseTo(-20, 5);
  });

  it('上月为 0 且本月为 0：返回 0', () => {
    expect(monthOverMonth(0, 0)).toBe(0);
  });

  it('上月为 0 且本月非 0：返回 100', () => {
    expect(monthOverMonth(50, 0)).toBe(100);
    expect(monthOverMonth(-50, 0)).toBe(100);
  });

  it('上月为负：使用 Math.abs 避免符号反转', () => {
    expect(monthOverMonth(-80, -100)).toBeCloseTo(20, 5);
  });
});

describe('buildCalendar', () => {
  it('按日聚合收入与支出，跨日交易正确归位', () => {
    const month = dayjs('2024-03-15');
    const march1 = month.startOf('month').valueOf();
    const march2 = march1 + 24 * 3600 * 1000;
    const txs: Transaction[] = [
      makeTx({ id: 1, type: 'income', amount: 500, date: march1 }),
      makeTx({ id: 2, type: 'expense', amount: 100, date: march1 }),
      makeTx({ id: 3, type: 'expense', amount: 200, date: march2 }),
      makeTx({ id: 4, type: 'transfer', amount: 999, date: march1 }),
      makeTx({ id: 5, type: 'excluded', amount: 999, date: march1 }),
    ];
    const cal = buildCalendar(txs, month);
    expect(cal).toHaveLength(31); // 3 月 31 天
    expect(cal[0].income).toBe(500);
    expect(cal[0].expense).toBe(100);
    expect(cal[0].count).toBe(2); // transfer / excluded 不计入
    expect(cal[1].income).toBe(0);
    expect(cal[1].expense).toBe(200);
    expect(cal[1].count).toBe(1);
    // 3 月 31 日 (index 30) 应无数据
    expect(cal[30].income).toBe(0);
    expect(cal[30].expense).toBe(0);
    expect(cal[30].count).toBe(0);
  });

  it('跨月数据不计入', () => {
    const month = dayjs('2024-03-15');
    const feb28 = dayjs('2024-02-28').valueOf();
    const apr1 = dayjs('2024-04-01').valueOf();
    const txs: Transaction[] = [
      makeTx({ id: 1, type: 'income', amount: 500, date: feb28 }),
      makeTx({ id: 2, type: 'expense', amount: 100, date: apr1 }),
    ];
    const cal = buildCalendar(txs, month);
    const totalIncome = cal.reduce((s, d) => s + d.income, 0);
    const totalExpense = cal.reduce((s, d) => s + d.expense, 0);
    expect(totalIncome).toBe(0);
    expect(totalExpense).toBe(0);
  });

  it('空交易：所有天全为 0', () => {
    const month = dayjs('2024-02-01');
    const cal = buildCalendar([], month);
    expect(cal).toHaveLength(29); // 2024 是闰年
    expect(cal.every((d) => d.income === 0 && d.expense === 0 && d.count === 0)).toBe(true);
  });
});
