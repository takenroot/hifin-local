import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  STATS_TYPES,
  STATS_TYPE_LABELS,
  UNCATEGORIZED_NAME,
  aggregateByCategory,
  currentMonth,
  isFutureMonth,
  isValidMonth,
  monthBounds,
  monthNumber,
  parseMonth,
  shiftMonth,
  totalOf,
  type StatsType,
} from '@/features/transactions/stats';
import type { Category, Transaction } from '@/db';

// ───────────── 工具 ─────────────
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

function at(s: string, extra: Partial<Transaction> = {}): Transaction {
  return makeTx({ date: dayjs(s).valueOf(), ...extra });
}

const CATS: Category[] = [
  { id: 1, name: '日常餐饮', group: '餐饮', type: 'expense', icon: '🍱' },
  { id: 2, name: '公共交通', group: '交通', type: 'expense', icon: '🚌' },
  { id: 3, name: '房租', group: '住房', type: 'expense', icon: '🏠' },
  { id: 4, name: '工资', group: '收入', type: 'income', icon: '💰' },
  { id: 5, name: '兼职', group: '收入', type: 'income', icon: '🧾' },
];

// ───────────── 月份工具 ─────────────
describe('月份工具', () => {
  it('monthBounds 是半开区间 [1日00:00, 次月1日00:00)', () => {
    const { from, to } = monthBounds('2026-09');
    expect(dayjs(from).format('YYYY-MM-DD HH:mm:ss')).toBe('2026-09-01 00:00:00');
    expect(dayjs(to).format('YYYY-MM-DD HH:mm:ss')).toBe('2026-10-01 00:00:00');
  });

  it('parseMonth 归一化，非法输入回落到当前月', () => {
    expect(parseMonth('2026-09').format('YYYY-MM')).toBe('2026-09');
    expect(parseMonth('2026-9').format('YYYY-MM')).toBe('2026-09');
    expect(parseMonth('2026-13').format('YYYY-MM')).toBe(currentMonth());
    expect(parseMonth('乱码').format('YYYY-MM')).toBe(currentMonth());
  });

  it('isValidMonth 只认 YYYY-MM', () => {
    expect(isValidMonth('2026-09')).toBe(true);
    expect(isValidMonth('2026-13')).toBe(false);
    expect(isValidMonth('2026-9')).toBe(false);
    expect(isValidMonth('202609')).toBe(false);
  });

  it('monthNumber 可比较大小', () => {
    expect(monthNumber('2026-09')).toBe(202609);
    expect(monthNumber('2026-09') < monthNumber('2026-10')).toBe(true);
    expect(monthNumber('2026-12') < monthNumber('2027-01')).toBe(true);
  });

  it('shiftMonth 前后翻页，含跨年', () => {
    expect(shiftMonth('2026-09', -1)).toBe('2026-08');
    expect(shiftMonth('2026-09', 1)).toBe('2026-10');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2025-12', 1)).toBe('2026-01');
  });

  it('当前月不算未来月，下一月算', () => {
    expect(isFutureMonth(currentMonth())).toBe(false);
    expect(isFutureMonth(shiftMonth(currentMonth(), 1))).toBe(true);
    expect(isFutureMonth(shiftMonth(currentMonth(), -1))).toBe(false);
  });

  it('收支方向常量成对出现', () => {
    expect(STATS_TYPES).toEqual(['expense', 'income']);
    expect(STATS_TYPE_LABELS).toEqual({ expense: '支出', income: '收入' });
  });
});

// ───────────── aggregateByCategory ─────────────
describe('aggregateByCategory —— 基本聚合', () => {
  const txs: Transaction[] = [
    at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 100, categoryId: 1 }),
    at('2026-09-05T10:00:00', { id: 2, type: 'expense', amount: 200, categoryId: 1 }),
    at('2026-09-10T10:00:00', { id: 3, type: 'expense', amount: 300, categoryId: 2 }),
    at('2026-09-15T10:00:00', { id: 4, type: 'expense', amount: 400, categoryId: 3 }),
  ];

  it('按分类聚合金额，带上名称与图标', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense', CATS);
    expect(rows).toEqual([
      { categoryId: 3, name: '房租', icon: '🏠', amount: 400, pct: 40 },
      { categoryId: 2, name: '公共交通', icon: '🚌', amount: 300, pct: 30 },
      { categoryId: 1, name: '日常餐饮', icon: '🍱', amount: 300, pct: 30 },
    ]);
  });

  it('占比之和为 100%', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense', CATS);
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 6);
  });

  it('结果按金额降序', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense', CATS);
    const amounts = rows.map((r) => r.amount);
    expect([...amounts].sort((a, b) => b - a)).toEqual(amounts);
  });

  it('同额时按名称升序，结果稳定', () => {
    const same: Transaction[] = [
      at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 50, categoryId: 2 }),
      at('2026-09-02T10:00:00', { id: 2, type: 'expense', amount: 50, categoryId: 1 }),
    ];
    const a = aggregateByCategory(same, '2026-09', 'expense', CATS);
    const b = aggregateByCategory([...same].reverse(), '2026-09', 'expense', CATS);
    expect(a.map((r) => r.name)).toEqual(['公共交通', '日常餐饮']);
    expect(b.map((r) => r.name)).toEqual(a.map((r) => r.name));
  });

  it('不传分类字典时全部归入「未分类」', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe(UNCATEGORIZED_NAME);
    expect(rows[0].categoryId).toBeUndefined();
    expect(rows[0].amount).toBe(1000);
    expect(rows[0].pct).toBe(100);
  });
});

describe('aggregateByCategory —— 收支方向隔离', () => {
  const txs: Transaction[] = [
    at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 100, categoryId: 1 }),
    at('2026-09-02T10:00:00', { id: 2, type: 'income', amount: 9000, categoryId: 4 }),
    at('2026-09-03T10:00:00', { id: 3, type: 'transfer', amount: 5000, toAccountId: 2, categoryId: 1 }),
    at('2026-09-04T10:00:00', { id: 4, type: 'excluded', amount: 7000 }),
  ];

  it('expense 只统计支出', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense', CATS);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(100);
    expect(rows[0].name).toBe('日常餐饮');
  });

  it('income 只统计收入', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'income', CATS);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(9000);
    expect(rows[0].name).toBe('工资');
  });

  it('transfer / excluded 不进入任何一侧', () => {
    for (const type of STATS_TYPES) {
      const total = totalOf(aggregateByCategory(txs, '2026-09', type, CATS));
      expect(total).toBe(type === 'expense' ? 100 : 9000);
    }
  });
});

describe('aggregateByCategory —— 月份边界', () => {
  const txs: Transaction[] = [
    at('2026-08-31T23:59:59', { id: 1, type: 'expense', amount: 11, categoryId: 1 }),
    at('2026-09-01T00:00:00', { id: 2, type: 'expense', amount: 22, categoryId: 1 }),
    at('2026-09-30T23:59:59', { id: 3, type: 'expense', amount: 33, categoryId: 1 }),
    at('2026-10-01T00:00:00', { id: 4, type: 'expense', amount: 44, categoryId: 1 }),
  ];

  it('左闭右开：8/31 不进 9 月，10/1 不进 9 月', () => {
    const rows = aggregateByCategory(txs, '2026-09', 'expense', CATS);
    expect(rows[0].amount).toBe(55); // 22 + 33
  });

  it('8 月只含 8/31，10 月只含 10/1', () => {
    expect(aggregateByCategory(txs, '2026-08', 'expense', CATS)[0].amount).toBe(11);
    expect(aggregateByCategory(txs, '2026-10', 'expense', CATS)[0].amount).toBe(44);
  });

  it('相邻月份互不串数据', () => {
    const sep = aggregateByCategory(
      [at('2026-08-15T10:00:00', { type: 'expense', amount: 5, categoryId: 1 })],
      '2026-09',
      'expense',
      CATS,
    );
    expect(sep).toEqual([]);
  });

  it('跨年：2025-12 与 2026-01 各自独立', () => {
    const crossYear: Transaction[] = [
      at('2025-12-31T23:00:00', { type: 'expense', amount: 7, categoryId: 1 }),
      at('2026-01-01T01:00:00', { type: 'expense', amount: 9, categoryId: 1 }),
    ];
    expect(aggregateByCategory(crossYear, '2025-12', 'expense', CATS)[0].amount).toBe(7);
    expect(aggregateByCategory(crossYear, '2026-01', 'expense', CATS)[0].amount).toBe(9);
  });
});

describe('aggregateByCategory —— 空与退化输入', () => {
  it('空数组返回空结果', () => {
    const type: StatsType = 'expense';
    expect(aggregateByCategory([], '2026-09', type, CATS)).toEqual([]);
    expect(totalOf([])).toBe(0);
  });

  it('该月无数据返回空结果（空态判定依据）', () => {
    const rows = aggregateByCategory([at('2026-01-10T10:00:00', { type: 'expense' })], '2026-09', 'expense', CATS);
    expect(rows).toEqual([]);
  });

  it('全部金额为 0 的分类不进榜', () => {
    const zeros: Transaction[] = [
      at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 0, categoryId: 1 }),
      at('2026-09-02T10:00:00', { id: 2, type: 'expense', amount: 0, categoryId: 2 }),
    ];
    expect(aggregateByCategory(zeros, '2026-09', 'expense', CATS)).toEqual([]);
  });

  it('无 categoryId 的流水归入「未分类」，与已知分类并列', () => {
    const mixed: Transaction[] = [
      at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 250, categoryId: 1 }),
      at('2026-09-02T10:00:00', { id: 2, type: 'expense', amount: 250 }),
    ];
    const rows = aggregateByCategory(mixed, '2026-09', 'expense', CATS);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.name).sort()).toEqual(['日常餐饮', UNCATEGORIZED_NAME]);
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 6);
  });

  it('categoryId 指向已删除的分类时回落为「未分类」', () => {
    const orphan = [at('2026-09-01T10:00:00', { type: 'expense', amount: 10, categoryId: 999 })];
    const rows = aggregateByCategory(orphan, '2026-09', 'expense', CATS);
    expect(rows[0].name).toBe(UNCATEGORIZED_NAME);
  });

  it('不修改入参数组', () => {
    const txs = [at('2026-09-01T10:00:00', { id: 1, type: 'expense', amount: 10, categoryId: 1 })];
    const snapshot = JSON.stringify(txs);
    aggregateByCategory(txs, '2026-09', 'expense', CATS);
    expect(JSON.stringify(txs)).toBe(snapshot);
  });
});

describe('aggregateByCategory —— 大样本占比守恒', () => {
  it('12 个分类、金额不整除时占比之和仍为 100%', () => {
    const cats: Category[] = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      name: `分类${i + 1}`,
      group: '测试',
      type: 'expense' as const,
      icon: '🍚',
    }));
    const txs = cats.map((c, i) =>
      at(`2026-09-${String(i + 1).padStart(2, '0')}T10:00:00`, {
        id: i + 1,
        type: 'expense',
        amount: (i + 1) * 7.77,
        categoryId: c.id,
      }),
    );
    const rows = aggregateByCategory(txs, '2026-09', 'expense', cats);
    expect(rows).toHaveLength(12);
    expect(rows.reduce((s, r) => s + r.pct, 0)).toBeCloseTo(100, 6);
    // pct 与 amount/total 一致
    const total = totalOf(rows);
    for (const r of rows) {
      expect(r.pct).toBeCloseTo((r.amount / total) * 100, 6);
    }
  });
});
