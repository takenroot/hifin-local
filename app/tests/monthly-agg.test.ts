/**
 * lib/monthlyAgg.ts 生产侧聚合口径测试（2026-10-06）
 * ---------------------------------------------------------------
 * monthlyAgg 是看板（/home）+ 实验室（/lab/legacy+zenith）共用的纯函数聚合层，
 * 测试聚焦"生产侧"的口径——与 lab-realdata.test.ts 区分：
 *   - lab-realdata：钉死 lab 静态形状契约（mock 同构、形状稳定）
 *   - monthly-agg：钉死"如果接 production REST 数据，聚合输出仍是合同形状"，
 *     覆盖回归点（空数组、跨年、Anchor漂移、长尾 NaN、负余额资产切片）。
 */
import { describe, it, expect } from 'vitest';
import {
  last12MonthKeys,
  monthKeyOf,
  toMonthlyPoints,
  toNetAssetMonthlySeries,
  toSavingsRateSeries,
  toLabStats,
  toSlices,
  type TxRow,
  type AccountRow,
  type SummaryRow,
} from '@/lib/monthlyAgg';

const NOW = new Date(2026, 9, 6, 12, 0, 0).getTime(); // 2026-10-06 正午
const DAY = 86400000;
const T = (ms: number, type: TxRow['type'], amount: number, name = 'x'): TxRow => ({
  date: ms,
  type,
  amount,
  name,
});

describe('last12MonthKeys — 生产锚定口径', () => {
  it('末月键 = 锚定所在月份，跨年首月键跨年正确', () => {
    const keys = last12MonthKeys(NOW);
    expect(keys).toHaveLength(12);
    expect(keys[keys.length - 1]).toBe('2026-10');
    expect(keys[0]).toBe('2025-11');
  });

  it('锚定跨年（now=2026-01-15）时序列仍以当月收尾', () => {
    const winter = new Date(2026, 0, 15).getTime();
    const keys = last12MonthKeys(winter);
    expect(keys[keys.length - 1]).toBe('2026-01');
    expect(keys[0]).toBe('2025-02');
  });
});

describe('toMonthlyPoints — 生产数据（空库 + 大跨度）', () => {
  it('空库：12 行全为 0', () => {
    const m = toMonthlyPoints([], NOW);
    expect(m).toHaveLength(12);
    expect(m.every((p) => p.income === 0 && p.expense === 0 && p.balance === 0)).toBe(true);
  });

  it('只含 transfer/excluded 的库：12 行全为 0（不污染交易日）', () => {
    const txs = [
      T(NOW, 'transfer', 9999),
      T(NOW, 'excluded', 5000),
    ];
    const m = toMonthlyPoints(txs, NOW);
    expect(m[11]).toEqual({ month: '2026-10', income: 0, expense: 0, balance: 0 });
  });

  it('大跨度（含 5 年前 100k 收入）：仅聚合 12 月窗口，窗口外全忽略', () => {
    const txs = [
      T(new Date(2021, 0, 1).getTime(), 'income', 100000),
      T(new Date(2026, 9, 1).getTime(), 'income', 12000),
      T(new Date(2026, 9, 15).getTime(), 'expense', 8000),
    ];
    const m = toMonthlyPoints(txs, NOW);
    expect(m[11]).toEqual({ month: '2026-10', income: 12000, expense: 8000, balance: 4000 });
    // 5 年前那笔不能进任何桶——首末=0, 11=4000，差额 4000
    const sum = m.reduce((s, p) => s + p.balance, 0);
    expect(sum).toBe(4000);
  });
});

describe('toNetAssetMonthlySeries — 末点恒等 summary.netAsset', () => {
  it('空库 + netAsset=0：末值 = 0', () => {
    const monthly = toMonthlyPoints([], NOW);
    const s = toNetAssetMonthlySeries(monthly, 0);
    expect(s[s.length - 1].value).toBe(0);
  });

  it('窗口内余额 + 窗口外 netAsset：末值仍锚定 netAsset', () => {
    const txs = [T(NOW, 'income', 3000), T(NOW, 'expense', 1000)];
    const monthly = toMonthlyPoints(txs, NOW);
    // netAsset 与月度差额无关，恒等于末值
    expect(toNetAssetMonthlySeries(monthly, 99999)[11].value).toBe(99999);
    expect(toNetAssetMonthlySeries(monthly, -1)[11].value).toBe(-1);
  });
});

describe('toSavingsRateSeries — 边界 / 长尾', () => {
  it('空库：12 行全为 0（除零守卫）', () => {
    const monthly = toMonthlyPoints([], NOW);
    const s = toSavingsRateSeries(monthly);
    expect(s.every((p) => p.value === 0)).toBe(true);
  });

  it('负收入（异常态）：rate = -200% 仍可计算，不变 NaN', () => {
    const txs = [T(NOW, 'income', 100), T(NOW, 'expense', 300)];
    const monthly = toMonthlyPoints(txs, NOW);
    const s = toSavingsRateSeries(monthly);
    expect(s[11].value).toBe(-200);
  });
});

describe('toLabStats — SummaryRow 与 monthly 联动', () => {
  it('摘要 4 字段（netAsset/income/expense/savings）全填齐，shape 与 Dashboard 期待一致', () => {
    const summary: SummaryRow = {
      netAsset: 12345.67,
      monthIncome: 8000,
      monthExpense: 5000,
      mom: { deltaPct: 2.5 },
    };
    const monthly = toMonthlyPoints(
      [T(NOW, 'income', 8000), T(NOW, 'expense', 5000)],
      NOW,
    );
    const stats = toLabStats(summary, monthly);
    expect(stats.netAsset.amount).toBe(12345.67);
    expect(stats.netAsset.deltaPct).toBe(2.5);
    expect(stats.income.amount).toBe(8000);
    expect(stats.expense.amount).toBe(5000);
    expect(typeof stats.savings.amount).toBe('number');
    expect(typeof stats.savings.deltaPct).toBe('number');
  });

  it('上月基数 0：收入/支出环比恒为 0（不产 Infinity）', () => {
    // monthly 只有末月——前月=last 月，差=0 → pct=0
    const summary: SummaryRow = {
      netAsset: 0,
      monthIncome: 100,
      monthExpense: 0,
      mom: null,
    };
    const monthly = toMonthlyPoints([T(NOW, 'income', 100)], NOW);
    const stats = toLabStats(summary, monthly);
    expect(stats.income.deltaPct).toBe(0);
    expect(stats.expense.deltaPct).toBe(0);
  });
});

describe('toSlices — 资产分布（看板 donut 直接消费）', () => {
  it('正余额 + 计入净资产 的账户进画；零/负余额、隐藏户一律不进', () => {
    // 注：AccountRow 最小形状不带 type 字段。toSlices 过滤的是
    // includeInNetAsset !== 0 && balance > 0；credit/debt 由调用方（生产
    // 看板的 accounts 适配层）预过滤，避免在纯函数里耦合全局 db 类型。
    const accounts: AccountRow[] = [
      { name: '零钱通', balance: 100, includeInNetAsset: 1 },
      { name: '基金', balance: 500, includeInNetAsset: 1 },
      { name: '花呗多还', balance: -50, includeInNetAsset: 1 }, // 负余额资产
      { name: '隐藏户', balance: 9999, includeInNetAsset: 0 }, // 不计净资产
      { name: '空户', balance: 0, includeInNetAsset: 1 }, // 零余额
    ];
    const slices = toSlices(accounts);
    expect(slices).toEqual([
      { name: '零钱通', value: 100 },
      { name: '基金', value: 500 },
    ]);
  });

  it('空账户列表：返回空（donut 走空态分支）', () => {
    expect(toSlices([])).toEqual([]);
  });
});

describe('monthKeyOf — 边界 / 跨年', () => {
  it('跨年当月（1 月）输出 2026-01 补零', () => {
    expect(monthKeyOf(new Date(2026, 0, 31).getTime())).toBe('2026-01');
  });

  it('年末（12 月）输出 2025-12 补零', () => {
    expect(monthKeyOf(new Date(2025, 11, 1).getTime())).toBe('2025-12');
  });
});