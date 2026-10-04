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
      makeAccount({ id: 3, type: 'credit', balance: -2000, includeInNetAsset: true }),
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

  it('负余额 credit/debt 记负债：净资产 = 资产 - 欠款', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'credit', balance: -1500, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'debt', balance: -3000, includeInNetAsset: true }),
    ];
    expect(calcNetAsset(accounts)).toBe(-(1500 + 3000));
  });

  it('正余额 credit/debt 记资产（多还/退款在途），不是负债', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 1000, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'credit', balance: 139.29, includeInNetAsset: true }),
    ];
    expect(calcNetAsset(accounts)).toBeCloseTo(1139.29, 6);
  });

  it('正负余额混合：净资产恒等于 Σ 计入账户的余额', () => {
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 1000, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'asset', balance: 5000, includeInNetAsset: true }),
      makeAccount({ id: 3, type: 'credit', balance: -1500, includeInNetAsset: true }),
      makeAccount({ id: 4, type: 'debt', balance: 300, includeInNetAsset: true }),
      makeAccount({ id: 5, type: 'invest', balance: -411.76, includeInNetAsset: true }),
    ];
    const sum = accounts.reduce((s, a) => s + a.balance, 0);
    expect(calcNetAsset(accounts)).toBeCloseTo(sum, 6);
  });

  it('回归 ISSUE-005：花呗正余额曾被当成负债，净资产比 Σ 余额少 2×139.29', () => {
    // 实测 7 账户形状（工行卡被还款扣成负数、花呗多还为正）
    const accounts: Account[] = [
      makeAccount({ id: 1, type: 'fund', balance: 12248.71, includeInNetAsset: true }),
      makeAccount({ id: 2, type: 'invest', balance: 960.81, includeInNetAsset: true }),
      makeAccount({ id: 3, type: 'invest', balance: -411.76, includeInNetAsset: true }),
      makeAccount({ id: 4, type: 'fund', balance: -36089.78, includeInNetAsset: true }),
      makeAccount({ id: 5, type: 'fund', balance: -2084.36, includeInNetAsset: true }),
      makeAccount({ id: 6, type: 'fund', balance: -3000, includeInNetAsset: true }),
      makeAccount({ id: 7, type: 'credit', balance: 139.29, includeInNetAsset: true }),
    ];
    const sum = accounts.reduce((s, a) => s + a.balance, 0);
    expect(sum).toBeCloseTo(-28237.09, 2);
    expect(calcNetAsset(accounts)).toBeCloseTo(-28237.09, 2);
    // 旧口径（Math.abs）会得到 -28515.67，即多扣了 2×139.29
    expect(calcNetAsset(accounts)).not.toBeCloseTo(-28515.67, 2);
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
