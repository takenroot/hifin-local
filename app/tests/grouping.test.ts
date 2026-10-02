import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  GROUP_DIMS,
  GROUP_DIM_LABELS,
  dimShowsSubtotal,
  groupTransactions,
  isoWeekOf,
  isoWeekRange,
  type GroupDim,
} from '@/features/transactions/grouping';
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

/** 'YYYY-MM-DD HH:mm' 固定时区无关地构造时间戳（本地时区） */
function at(s: string, extra: Partial<Transaction> = {}): Transaction {
  return makeTx({ date: dayjs(s).valueOf(), ...extra });
}

const TODAY = dayjs('2026-10-03T12:00:00'); // 周六

describe('isoWeekOf —— ISO-8601 周编号（周一起始）', () => {
  it('2026-09-21(周一) ~ 2026-09-27(周日) 同属第 39 周', () => {
    expect(isoWeekOf(dayjs('2026-09-21'))).toEqual({ year: 2026, week: 39 });
    expect(isoWeekOf(dayjs('2026-09-27'))).toEqual({ year: 2026, week: 39 });
  });

  it('同周内任意一天得到同一个周编号', () => {
    const days = ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27'];
    const weeks = new Set(days.map((d) => JSON.stringify(isoWeekOf(dayjs(d)))));
    expect(weeks.size).toBe(1);
  });

  it('跨月边界：8/31(周一) 与 9/1(周二) 同属第 36 周', () => {
    // 第 1 周起于 2025-12-29；2026-08-31 距其 245 天 = 35 周 → 第 36 周
    expect(isoWeekOf(dayjs('2026-08-31'))).toEqual(isoWeekOf(dayjs('2026-09-01')));
    expect(isoWeekOf(dayjs('2026-08-31')).week).toBe(36);
  });

  it('跨年边界：2025-12-29(周一) ~ 2026-01-04(周日) 属 2026 年第 1 周', () => {
    // 周四落在 2026-01-01 → 周所属年份是 2026（不是 2025）
    expect(isoWeekOf(dayjs('2025-12-29'))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf(dayjs('2026-01-01'))).toEqual({ year: 2026, week: 1 });
    expect(isoWeekOf(dayjs('2026-01-04'))).toEqual({ year: 2026, week: 1 });
  });

  it('年末：2026-12-28 ~ 2027-01-03 属 2026 年第 53 周', () => {
    expect(isoWeekOf(dayjs('2026-12-28'))).toEqual({ year: 2026, week: 53 });
    expect(isoWeekOf(dayjs('2027-01-03'))).toEqual({ year: 2026, week: 53 });
  });

  it('周日(day()=0) 与周一(day()=1) 视为同周边界', () => {
    // 2026-09-27 是周日，day() 返回 0；归一后应落在同一周
    expect(dayjs('2026-09-27').day()).toBe(0);
    expect(isoWeekOf(dayjs('2026-09-27')).week).toBe(isoWeekOf(dayjs('2026-09-21')).week);
  });
});

describe('isoWeekRange —— 周一 00:00 为起点', () => {
  it('周中任意一天都回落到同一个周一', () => {
    const starts = new Set(
      ['2026-09-21', '2026-09-23', '2026-09-27'].map((d) => isoWeekRange(dayjs(d)).start),
    );
    expect(starts.size).toBe(1);
    expect(dayjs([...starts][0]).format('YYYY-MM-DD HH:mm:ss')).toBe('2026-09-21 00:00:00');
  });

  it('end = start + 7 天', () => {
    const { start, end } = isoWeekRange(dayjs('2026-10-01'));
    expect(end - start).toBe(7 * 24 * 3600 * 1000);
  });
});

describe('groupTransactions —— 日档', () => {
  it('今天 / 昨天 / 具体日期三种标题', () => {
    const txs = [
      at('2026-10-03T09:00:00', { id: 1 }),
      at('2026-10-02T09:00:00', { id: 2 }),
      at('2026-09-27T09:00:00', { id: 3 }),
    ];
    const g = groupTransactions(txs, 'day', TODAY);
    expect(g.map((x) => x.label)).toEqual(['今天', '昨天', '2026年9月27日 Sun']);
  });

  it('今天置顶、昨天次之、其余按日期倒序', () => {
    const txs = [
      at('2026-09-01T09:00:00', { id: 1 }),
      at('2026-10-03T09:00:00', { id: 2 }),
      at('2026-09-20T09:00:00', { id: 3 }),
      at('2026-10-02T09:00:00', { id: 4 }),
    ];
    const g = groupTransactions(txs, 'day', TODAY);
    expect(g.map((x) => x.label)).toEqual([
      '今天',
      '昨天',
      '2026年9月20日 Sun',
      '2026年9月1日 Tue',
    ]);
  });

  it('同一天多笔合并到一组，组内保持传入顺序', () => {
    const txs = [
      at('2026-10-03T09:00:00', { id: 1 }),
      at('2026-10-03T21:00:00', { id: 2 }),
      at('2026-10-03T12:00:00', { id: 3 }),
    ];
    const g = groupTransactions(txs, 'day', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].txs.map((t) => t.id)).toEqual([1, 2, 3]);
  });

  it('日档 key 形如 d-YYYY-MM-DD', () => {
    const g = groupTransactions([at('2026-10-03T09:00:00')], 'day', TODAY);
    expect(g[0].key).toBe('d-2026-10-03');
  });

  it('日档不带小计（保持既有样式）', () => {
    expect(dimShowsSubtotal('day')).toBe(false);
  });
});

describe('groupTransactions —— 周档', () => {
  it('标题为「2026年第39周（9.21-9.27）」，周一起始', () => {
    const txs = [
      at('2026-09-21T10:00:00', { id: 1, type: 'expense', amount: 30 }),
      at('2026-09-27T23:00:00', { id: 2, type: 'expense', amount: 70 }),
    ];
    const g = groupTransactions(txs, 'week', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('2026年第39周（9.21-9.27）');
    expect(g[0].key).toBe('w-2026-39');
    expect(g[0].subExpense).toBe(100);
  });

  it('周日归属本周而不是下周（周一起始的关键）', () => {
    // 2026-09-27 是周日，2026-09-28 是周一 → 两个不同的周
    const sun = groupTransactions([at('2026-09-27T10:00:00')], 'week', TODAY);
    const mon = groupTransactions([at('2026-09-28T10:00:00')], 'week', TODAY);
    expect(sun[0].key).toBe('w-2026-39');
    expect(mon[0].key).toBe('w-2026-40');
  });

  it('跨月周：8/31 与 9/1 落在同一组', () => {
    const txs = [at('2026-08-31T10:00:00', { id: 1 }), at('2026-09-01T10:00:00', { id: 2 })];
    const g = groupTransactions(txs, 'week', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('2026年第36周（8.31-9.6）');
  });

  it('跨年周：2025-12-29 与 2026-01-01 落在同一组，标题年取 2026', () => {
    const txs = [at('2025-12-29T10:00:00', { id: 1 }), at('2026-01-01T10:00:00', { id: 2 })];
    const g = groupTransactions(txs, 'week', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('2026年第1周（12.29-1.4）');
    expect(g[0].key).toBe('w-2026-01');
  });

  it('多个周按周期倒序', () => {
    const txs = [
      at('2026-09-21T10:00:00', { id: 1 }),
      at('2026-10-01T10:00:00', { id: 2 }),
      at('2026-09-01T10:00:00', { id: 3 }),
    ];
    const g = groupTransactions(txs, 'week', TODAY);
    expect(g.map((x) => x.key)).toEqual(['w-2026-40', 'w-2026-39', 'w-2026-36']);
  });

  it('周档带收支小计', () => {
    const txs = [
      at('2026-09-21T10:00:00', { id: 1, type: 'expense', amount: 100 }),
      at('2026-09-22T10:00:00', { id: 2, type: 'expense', amount: 50 }),
      at('2026-09-23T10:00:00', { id: 3, type: 'income', amount: 800 }),
      at('2026-09-24T10:00:00', { id: 4, type: 'transfer', amount: 999, toAccountId: 2 }),
      at('2026-09-25T10:00:00', { id: 5, type: 'excluded', amount: 777 }),
    ];
    const g = groupTransactions(txs, 'week', TODAY);
    expect(g[0].subExpense).toBe(150);
    expect(g[0].subIncome).toBe(800);
  });
});

describe('groupTransactions —— 月档', () => {
  it('标题为「2026年9月」，key 形如 m-YYYY-MM', () => {
    const txs = [at('2026-09-01T00:30:00', { id: 1 }), at('2026-09-30T23:30:00', { id: 2 })];
    const g = groupTransactions(txs, 'month', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('2026年9月');
    expect(g[0].key).toBe('m-2026-09');
  });

  it('同月合并、按月倒序、小计正确', () => {
    const txs = [
      at('2026-07-05T10:00:00', { id: 1, type: 'expense', amount: 10 }),
      at('2026-08-05T10:00:00', { id: 2, type: 'expense', amount: 20 }),
      at('2026-09-05T10:00:00', { id: 3, type: 'expense', amount: 30 }),
      at('2026-09-20T10:00:00', { id: 4, type: 'income', amount: 500 }),
    ];
    const g = groupTransactions(txs, 'month', TODAY);
    expect(g.map((x) => x.label)).toEqual(['2026年9月', '2026年8月', '2026年7月']);
    expect(g[0].subExpense).toBe(30);
    expect(g[0].subIncome).toBe(500);
    expect(g[2].subExpense).toBe(10);
  });

  it('月份边界：9/30 23:59 与 10/1 00:00 分属两组', () => {
    const txs = [at('2026-09-30T23:59:00', { id: 1 }), at('2026-10-01T00:00:00', { id: 2 })];
    const g = groupTransactions(txs, 'month', TODAY);
    expect(g).toHaveLength(2);
    expect(g.map((x) => x.key)).toEqual(['m-2026-10', 'm-2026-09']);
  });
});

describe('groupTransactions —— 年档', () => {
  it('标题为「2026年」，key 形如 y-YYYY', () => {
    const txs = [at('2026-01-01T00:00:00', { id: 1 }), at('2026-12-31T23:00:00', { id: 2 })];
    const g = groupTransactions(txs, 'year', TODAY);
    expect(g).toHaveLength(1);
    expect(g[0].label).toBe('2026年');
    expect(g[0].key).toBe('y-2026');
  });

  it('跨年按年倒序，小计只累计收支', () => {
    const txs = [
      at('2024-05-01T10:00:00', { id: 1, type: 'expense', amount: 100 }),
      at('2025-05-01T10:00:00', { id: 2, type: 'expense', amount: 200 }),
      at('2026-05-01T10:00:00', { id: 3, type: 'expense', amount: 300 }),
      at('2026-06-01T10:00:00', { id: 4, type: 'income', amount: 9000 }),
      at('2026-07-01T10:00:00', { id: 5, type: 'transfer', amount: 5000, toAccountId: 2 }),
    ];
    const g = groupTransactions(txs, 'year', TODAY);
    expect(g.map((x) => x.key)).toEqual(['y-2026', 'y-2025', 'y-2024']);
    expect(g[0].subExpense).toBe(300);
    expect(g[0].subIncome).toBe(9000);
    expect(g[2].subIncome).toBe(0);
  });
});

describe('groupTransactions —— 边界与元数据', () => {
  it('空数组返回空分组', () => {
    for (const dim of GROUP_DIMS) {
      expect(groupTransactions([], dim, TODAY)).toEqual([]);
    }
  });

  it('四个维度都带齐 key/label/subExpense/subIncome/txs/start 字段', () => {
    const dims: GroupDim[] = ['day', 'week', 'month', 'year'];
    for (const dim of dims) {
      const g = groupTransactions([at('2026-09-21T10:00:00', { amount: 42 })], dim, TODAY);
      expect(Object.keys(g[0]).sort()).toEqual(
        ['key', 'label', 'start', 'subExpense', 'subIncome', 'txs'].sort(),
      );
      expect(g[0].subExpense).toBe(42);
      expect(g[0].subIncome).toBe(0);
    }
  });

  it('每个维度都有中文档位名，且除日档外都带小计', () => {
    for (const d of GROUP_DIMS) {
      expect(GROUP_DIM_LABELS[d]).toBeTruthy();
    }
    expect(GROUP_DIM_LABELS).toEqual({ day: '日', week: '周', month: '月', year: '年' });
    expect(dimShowsSubtotal('day')).toBe(false);
    expect(dimShowsSubtotal('week')).toBe(true);
    expect(dimShowsSubtotal('month')).toBe(true);
    expect(dimShowsSubtotal('year')).toBe(true);
  });

  it('全维度总笔数守恒（分组不丢不重）', () => {
    const txs = [
      at('2026-09-21T10:00:00', { id: 1 }),
      at('2026-09-28T10:00:00', { id: 2 }),
      at('2025-12-29T10:00:00', { id: 3 }),
      at('2026-01-04T10:00:00', { id: 4 }),
      at('2026-10-03T10:00:00', { id: 5 }),
    ];
    for (const dim of GROUP_DIMS) {
      const g = groupTransactions(txs, dim, TODAY);
      expect(g.reduce((s, x) => s + x.txs.length, 0)).toBe(txs.length);
      expect(g.flatMap((x) => x.txs).map((t) => t.id).sort()).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it('不修改入参数组', () => {
    const txs = [at('2026-09-21T10:00:00', { id: 1 }), at('2026-09-22T10:00:00', { id: 2 })];
    const snapshot = JSON.stringify(txs);
    groupTransactions(txs, 'month', TODAY);
    expect(JSON.stringify(txs)).toBe(snapshot);
  });
});
