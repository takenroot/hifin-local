/**
 * 看板预算卡「本期已花」聚合（预算卡从占位接真数据）
 * ---------------------------------------------------------------
 * core 没有 budget-spent 端点，所以和 /budget 页是同一套本地聚合：
 * 按预算自身周期取 [from, to) 窗口、只算 expense、categoryId 非空时按分类过滤。
 * at 显式传参 → 窗口边界在测试里可复现（不依赖"今天是哪天"）。
 */
import { describe, it, expect } from 'vitest';
import { buildBudgetProgress } from '@/features/dashboard/calculations';
import type { Budget, Transaction } from '@/db';

const AT = new Date(2026, 9, 5, 12, 0, 0); // 2026-10-05
const at = (y: number, m: number, d: number) => new Date(y, m, d, 12, 0, 0).getTime();

function budget(partial: Partial<Budget> = {}): Budget {
  return {
    id: 1,
    name: '餐饮',
    categoryId: null,
    amount: 2000,
    period: 'monthly',
    spaceId: 1,
    createdAt: 0,
    ...partial,
  };
}

function tx(partial: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    type: 'expense',
    name: '晚餐',
    amount: 100,
    date: at(2026, 9, 3),
    accountId: 1,
    categoryId: 7,
    includeInAsset: true,
    createdAt: 0,
    ...partial,
  };
}

describe('看板预算卡：本期已花聚合', () => {
  it('月度预算只吃当前自然月的支出', () => {
    const rows = buildBudgetProgress([budget()], [
      tx({ amount: 560 }),
      tx({ date: at(2026, 8, 28) }), // 上月，不计
      tx({ date: at(2026, 10, 1) }), // 下月，不计
      tx({ type: 'income', amount: 999 }), // 收入，不计
      tx({ type: 'transfer', amount: 999 }), // 转账，不计
    ], AT);
    expect(rows[0].spent).toBe(560);
    expect(rows[0].pct).toBeCloseTo(28, 5);
    expect(rows[0].overspent).toBe(false);
  });

  it('年度预算吃当年 1/1 起的全部支出（月度窗口外的也算）', () => {
    const rows = buildBudgetProgress([budget({ period: 'yearly', amount: 60000 })], [
      tx({ date: at(2026, 0, 15), amount: 40000 }),
      tx({ date: at(2025, 11, 30), amount: 500 }), // 上一年，不计
    ], AT);
    expect(rows[0].spent).toBe(40000);
    expect(rows[0].pct).toBeCloseTo(66.667, 2);
  });

  it('categoryId 非空只算该分类；null（总预算）算全部支出', () => {
    const txs = [tx({ categoryId: 7, amount: 100 }), tx({ categoryId: 9, amount: 250 })];
    const [scoped] = buildBudgetProgress([budget({ categoryId: 7 })], txs, AT);
    const [all] = buildBudgetProgress([budget({ categoryId: null })], txs, AT);
    expect(scoped.spent).toBe(100);
    expect(all.spent).toBe(350);
  });

  it('超支被标出来（超支是异常态，UI 走 danger 令牌）', () => {
    const [row] = buildBudgetProgress([budget({ amount: 500 })], [tx({ amount: 560 })], AT);
    expect(row.spent).toBe(560);
    expect(row.pct).toBeCloseTo(112, 5);
    expect(row.overspent).toBe(true);
  });

  it('额度为 0 不做除零：pct=0、不报超支', () => {
    const [row] = buildBudgetProgress([budget({ amount: 0 })], [tx({ amount: 560 })], AT);
    expect(row.pct).toBe(0);
    expect(row.overspent).toBe(false);
  });

  it('无预算返回空数组 —— 看板据此渲染「设置本月预算」空态', () => {
    expect(buildBudgetProgress([], [tx()], AT)).toEqual([]);
  });
});
