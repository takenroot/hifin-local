/**
 * 视觉实验室（/lab/zenith）测试——只测数据生成器的确定性与结构契约，
 * 不测 CSS/DOM（实验室页有意允许违反规范）。与 lab-dashboard.test.ts 风格一致。
 */
import { describe, it, expect } from 'vitest';
import {
  LAB_ANCHOR,
  LAB_STATS,
  genLabMonthly,
  genLabNetAssetSeries,
  genLabSavingsRateSeries,
  LAB_GOALS,
  LAB_RECENT_TX,
  LAB_SAVINGS_RATE,
} from '@/features/lab/DashboardLab';

describe('zenith 静态数据：确定性（对照实验前提）', () => {
  it('同一天任意次数调用，月度数据逐点一致', () => {
    const a = genLabMonthly();
    const b = genLabMonthly();
    expect(a).toEqual(b);
  });

  it('默认 12 个月，末月标签 = LAB_ANCHOR 所在月', () => {
    const m = genLabMonthly();
    expect(m).toHaveLength(12);
    // LAB_ANCHOR = '2026-10-06' → 末月 = 2026-10
    expect(m[11].month).toBe('2026-10');
    expect(m[0].month).toBe('2025-11');
  });

  it('末月收入 / 支出与 LAB_STATS 完全对齐（卡数字 = Overview 末点）', () => {
    const m = genLabMonthly();
    expect(m[11].income).toBe(LAB_STATS.income.amount);
    expect(m[11].expense).toBe(LAB_STATS.expense.amount);
  });

  it('balance = income - expense（每行自洽）', () => {
    for (const p of genLabMonthly()) {
      expect(p.balance).toBe(p.income - p.expense);
    }
  });

  it('所有月份 income / expense 为正（无负值或 0）', () => {
    for (const p of genLabMonthly()) {
      expect(p.income).toBeGreaterThan(0);
      expect(p.expense).toBeGreaterThan(0);
    }
  });
});

describe('zenith 衍生序列', () => {
  it('净资产序列末值 = LAB_STATS.netAsset（卡片数字自洽）', () => {
    const s = genLabNetAssetSeries();
    expect(s).toHaveLength(12);
    expect(s[11].value).toBeCloseTo(LAB_STATS.netAsset.amount, 2);
  });

  it('储蓄率序列：百分比 0..100，末值 = LAB_SAVINGS_RATE', () => {
    const s = genLabSavingsRateSeries();
    expect(s).toHaveLength(12);
    for (const p of s) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
    expect(s[11].value).toBeCloseTo(LAB_SAVINGS_RATE, 2);
  });
});

describe('zenith 静态集合结构契约', () => {
  it('LAB_GOALS：3 条，current/target 为正且 current < target（进度条能合理显示）', () => {
    expect(LAB_GOALS).toHaveLength(3);
    for (const g of LAB_GOALS) {
      expect(g.current).toBeGreaterThan(0);
      expect(g.target).toBeGreaterThan(g.current);
    }
  });

  it('LAB_RECENT_TX：6 条，金额有正有负（区分收支）', () => {
    expect(LAB_RECENT_TX).toHaveLength(6);
    const incomes = LAB_RECENT_TX.filter((t) => t.amount > 0);
    const expenses = LAB_RECENT_TX.filter((t) => t.amount < 0);
    expect(incomes.length).toBeGreaterThanOrEqual(1);
    expect(expenses.length).toBeGreaterThanOrEqual(1);
  });

  it('LAB_RECENT_TX：日期全部不晚于 LAB_ANCHOR', () => {
    for (const tx of LAB_RECENT_TX) {
      expect(tx.date <= LAB_ANCHOR).toBe(true);
    }
  });

  it('LAB_SAVINGS_RATE：与末月 (income-expense)/income 计算一致', () => {
    const last = genLabMonthly()[11];
    const expected = Math.round(((last.income - last.expense) / last.income) * 10000) / 100;
    expect(LAB_SAVINGS_RATE).toBeCloseTo(expected, 2);
  });
});
