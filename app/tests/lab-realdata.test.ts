/**
 * lab 真实数据映射的纯函数测试（labData.ts）
 * 钉死口径：与 mock 生成器同构，开关切换时只有数字来源变、形状不变。
 */
import { describe, it, expect } from 'vitest';
import {
  toMonthlyPoints,
  toDailyNetSeries,
  toNetAssetMonthlySeries,
  toSavingsRateSeries,
  toLabStats,
  toSlices,
  monthKeyOf,
  dateKeyOf,
  last12MonthKeys,
  type TxRow,
} from '@/features/lab/labData';

const T = (ms: number, type: TxRow['type'], amount: number): TxRow => ({ date: ms, type, amount, name: 'x' });
// 固定锚点：2026-10-06 本地正午
const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime();
const DAY = 86400000;

describe('月份/日期键', () => {
  it('monthKeyOf / dateKeyOf 输出补零格式', () => {
    expect(monthKeyOf(new Date(2026, 0, 31).getTime())).toBe('2026-01');
    expect(dateKeyOf(new Date(2026, 9, 6).getTime())).toBe('2026-10-06');
  });

  it('last12MonthKeys 含当月、长度 12、跨年正确', () => {
    const keys = last12MonthKeys(NOW);
    expect(keys).toHaveLength(12);
    expect(keys[11]).toBe('2026-10');
    expect(keys[0]).toBe('2025-11');
  });
});

describe('toMonthlyPoints', () => {
  it('按收入/支出聚合、transfer 不计、窗口外忽略、缺月补零', () => {
    const txs = [
      T(new Date(2026, 9, 1).getTime(), 'income', 5000),
      T(new Date(2026, 9, 2).getTime(), 'expense', 1200),
      T(new Date(2026, 9, 3).getTime(), 'transfer', 999), // 不计
      T(new Date(2026, 8, 15).getTime(), 'expense', 800),
      T(new Date(2025, 0, 1).getTime(), 'income', 100000), // 12 个月窗外，忽略
    ];
    const m = toMonthlyPoints(txs, NOW);
    expect(m).toHaveLength(12);
    expect(m[11]).toEqual({ month: '2026-10', income: 5000, expense: 1200, balance: 3800 });
    expect(m[10]).toEqual({ month: '2026-09', income: 0, expense: 800, balance: -800 });
    expect(m[0].income).toBe(0); // 2025-11 无数据补零
  });
});

describe('toDailyNetSeries', () => {
  it('末点恰好锚定 netAsset（与 mock genLabTrend 同口径）', () => {
    const txs = [T(NOW - DAY, 'income', 1000), T(NOW, 'expense', 300)];
    const series = toDailyNetSeries(txs, 37033.25, NOW);
    expect(series).toHaveLength(30);
    expect(series[29].date).toBe(dateKeyOf(NOW));
    expect(series[29].value).toBeCloseTo(37033.25, 2);
  });

  it('窗口外流水不影响锚定', () => {
    const txs = [T(NOW - 60 * DAY, 'income', 50000)];
    const series = toDailyNetSeries(txs, 10000, NOW);
    expect(series[29].value).toBeCloseTo(10000, 2);
  });
});

describe('toNetAssetMonthlySeries / toSavingsRateSeries', () => {
  it('月序列末点锚定 netAsset', () => {
    const monthly = toMonthlyPoints([T(NOW, 'income', 3000), T(NOW, 'expense', 1000)], NOW);
    const s = toNetAssetMonthlySeries(monthly, 9999);
    expect(s).toHaveLength(12);
    expect(s[11].value).toBeCloseTo(9999, 2);
  });

  it('储蓄率：收入为 0 的月份记 0（除零守卫）', () => {
    const monthly = toMonthlyPoints([], NOW);
    const s = toSavingsRateSeries(monthly);
    expect(s[11].value).toBe(0);
    const withTx = toMonthlyPoints([T(NOW, 'income', 4000), T(NOW, 'expense', 1000)], NOW);
    expect(toSavingsRateSeries(withTx)[11].value).toBe(75);
  });
});

describe('toLabStats', () => {
  it('净资产环比取 summary.mom；收入/支出环比用末月 vs 前月；基数 0 不产 Infinity', () => {
    const monthly = [
      { month: '2026-09', income: 10000, expense: 5000, balance: 5000 },
      { month: '2026-10', income: 12000, expense: 4000, balance: 8000 },
    ];
    const stats = toLabStats(
      { netAsset: 37033.25, monthIncome: 12000, monthExpense: 4000, mom: { deltaPct: -1.49 } },
      monthly,
    );
    expect(stats.netAsset).toEqual({ amount: 37033.25, deltaPct: -1.49 });
    expect(stats.income.deltaPct).toBe(20); // (12000-10000)/10000
    expect(stats.expense.deltaPct).toBe(-20); // 支出减少 20%（页面 invert 判好事）
    expect(stats.savings.amount).toBeCloseTo(66.67, 1); // 8000/12000
  });
});

describe('toSlices', () => {
  it('只保留计入净资产且余额为正的账户', () => {
    const slices = toSlices([
      { name: '零钱通', balance: 100, includeInNetAsset: 1 },
      { name: '花呗', balance: -50, includeInNetAsset: 1 }, // 负余额负债不画
      { name: '隐藏户', balance: 999, includeInNetAsset: 0 }, // 不计净资产
      { name: '空户', balance: 0, includeInNetAsset: 1 }, // 零余额不画
    ]);
    expect(slices).toEqual([{ name: '零钱通', value: 100 }]);
  });
});
