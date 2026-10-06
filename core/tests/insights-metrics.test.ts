/**
 * core/src/insights/metrics.ts + math.ts 单测。
 *
 * 测试要点：
 *  - 移植自 app/discover/insights.ts 的纯函数：sumByType / topCategories /
 *    monthOverMonth / largestExpense / budgetAlerts / upcomingGoals
 *    边界口径与原版一致（includeInAsset=0 排除、total=0 返回 []、prev=0 → null）；
 *  - computeMonthMetrics 聚合字段数与口径：anomalyLarge = 单笔 > 月均 × 5；
 *  - monthRange 复用 summary.ts 的 summaryHelpers.monthRange：YYYY-MM 非法 → null。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { computeMonthMetrics } from '../src/insights/metrics.js';
import {
  budgetAlerts,
  largestExpense,
  monthOverMonth,
  sumByType,
  topCategories,
  upcomingGoals,
} from '../src/insights/math.js';
import type {
  BudgetRow,
  CategoryRow,
  GoalRow,
  TransactionRow,
} from '../src/db/schema.js';

function freshDb(): Database.Database {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function seedAccount(db: Database.Database, name = '现金', balance = 0): number {
  const r = db
    .prepare(
      `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
       VALUES (?, 'fund', ?, 1, 1, 1, 1)`,
    )
    .run(name, balance);
  return Number(r.lastInsertRowid);
}

function seedCategory(
  db: Database.Database,
  name: string,
  type: 'expense' | 'income' = 'expense',
  id: number | null = null,
): number {
  const r = id == null
    ? db
        .prepare(`INSERT INTO categories (name, "group", type, icon, color) VALUES (?, '测试', ?, '🔥', '#fff')`)
        .run(name, type)
    : db
        .prepare(`INSERT INTO categories (id, name, "group", type, icon, color) VALUES (?, ?, '测试', ?, '🔥', '#fff')`)
        .run(id, name, type);
  return Number(r.lastInsertRowid);
}

function seedTx(
  db: Database.Database,
  t: Pick<TransactionRow, 'type' | 'name' | 'amount' | 'date'> & {
    categoryId?: number;
    includeInAsset?: number;
  },
): void {
  const accountId = seedAccount(db);
  db.prepare(
    `INSERT INTO transactions (type, name, amount, date, accountId, categoryId, includeInAsset, spaceId, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)`,
  ).run(
    t.type,
    t.name,
    t.amount,
    t.date,
    accountId,
    t.categoryId ?? null,
    t.includeInAsset ?? 1,
  );
}

let db: Database.Database;
beforeEach(() => {
  db?.close?.();
  db = freshDb();
});

describe('math：纯函数（与 app/discover/insights.ts 同口径）', () => {
  it('sumByType：includeInAsset=0 与 type=transfer 一律不计', () => {
    const txs = [
      { type: 'expense' as const, name: 'A', amount: 100, date: 1, includeInAsset: 1 },
      { type: 'expense' as const, name: 'B', amount: 50, date: 1, includeInAsset: 0 },
      { type: 'transfer' as const, name: 'C', amount: 200, date: 1, includeInAsset: 1 },
      { type: 'expense' as const, name: 'D', amount: 30, date: 100, includeInAsset: 1 },
    ];
    expect(sumByType(txs as unknown as TransactionRow[], 'expense', 0, 50)).toBe(100);
  });

  it('topCategories：total=0 → [] 不除零', () => {
    const result = topCategories([], [], 0, 100);
    expect(result).toEqual([]);
  });

  it('monthOverMonth：prev=0 → null', () => {
    expect(monthOverMonth(100, 0)).toBeNull();
    expect(monthOverMonth(50, -100)).toBe(150); // (50-(-100)) / |−100| = 150/100 = 150
  });

  it('largestExpense：单笔最大支出；无支出 → null', () => {
    expect(largestExpense([])).toBeNull();
    seedTx(db, { type: 'expense', name: '小', amount: 10, date: 1 });
    seedTx(db, { type: 'expense', name: '大', amount: 200, date: 2 });
    const all = db.prepare('SELECT * FROM transactions').all() as TransactionRow[];
    const largest = largestExpense(all);
    expect(largest?.name).toBe('大');
    expect(largest?.amount).toBe(200);
  });

  it('budgetAlerts：threshold 过滤 + 按 categoryId 过滤', () => {
    const catA = seedCategory(db, 'A');
    const catB = seedCategory(db, 'B');
    const budgets: BudgetRow[] = [
      { id: 1, name: 'A预算', categoryId: catA, amount: 100, period: 'monthly', createdAt: 1 },
      { id: 2, name: 'B预算', categoryId: catB, amount: 100, period: 'monthly', createdAt: 1 },
    ];
    seedTx(db, { type: 'expense', name: 'a1', amount: 85, date: new Date(2026, 0, 5).getTime(), categoryId: catA });
    seedTx(db, { type: 'expense', name: 'b1', amount: 50, date: new Date(2026, 0, 6).getTime(), categoryId: catB });
    seedTx(db, { type: 'expense', name: 'b2', amount: 50, date: new Date(2026, 0, 7).getTime(), categoryId: catB }); // B 达 100%
    const txs = db.prepare('SELECT * FROM transactions').all() as TransactionRow[];
    const alerts = budgetAlerts(budgets, txs, 80, new Date(2026, 0, 15));
    expect(alerts.map((a) => a.budget.name).sort()).toEqual(['A预算', 'B预算']);
  });

  it('upcomingGoals：30 天窗口 + 截止日升序（原生 Date 不用 dayjs）', () => {
    const now = new Date(2026, 0, 10).getTime();
    const goals: GoalRow[] = [
      { id: 1, kind: 'saving', name: 'A', targetAmount: 1000, currentAmount: 0, deadline: new Date(2026, 0, 15).getTime(), createdAt: 1 },
      { id: 2, kind: 'saving', name: 'B', targetAmount: 1000, currentAmount: 0, deadline: new Date(2026, 1, 28).getTime(), createdAt: 1 },
      { id: 3, kind: 'saving', name: '已完成', targetAmount: 100, currentAmount: 100, deadline: new Date(2026, 0, 12).getTime(), createdAt: 1 },
      { id: 4, kind: 'saving', name: '过期', targetAmount: 100, currentAmount: 0, deadline: new Date(2025, 11, 1).getTime(), createdAt: 1 },
    ];
    const result = upcomingGoals(goals, 30, now);
    expect(result.map((g) => g.name)).toEqual(['A']);
  });
});

describe('computeMonthMetrics：聚合字段与异常大额定义', () => {
  it('month 非法 → null（不抛）', () => {
    expect(computeMonthMetrics(db, '2026-13')).toBeNull();
    expect(computeMonthMetrics(db, 'bad')).toBeNull();
  });

  it('空数据月：income/expense 都为 0，momPct=null，无异常大额', () => {
    const m = computeMonthMetrics(db, '2026-01');
    expect(m).not.toBeNull();
    expect(m!.income).toBe(0);
    expect(m!.expense).toBe(0);
    expect(m!.net).toBe(0);
    expect(m!.momPct).toBeNull(); // 上月也无数据
    expect(m!.topExpense).toEqual([]);
    expect(m!.largest).toBeNull();
    expect(m!.anomalyLarge).toEqual([]);
  });

  it('收入 / 支出 / 净收支 + 环比正确', () => {
    // 上月 2025-12：收入 1000，支出 400
    seedTx(db, { type: 'income', name: '工资', amount: 1000, date: new Date(2025, 11, 5).getTime() });
    seedTx(db, { type: 'expense', name: '吃饭', amount: 400, date: new Date(2025, 11, 10).getTime() });
    // 本月 2026-01：收入 1500，支出 600
    seedTx(db, { type: 'income', name: '工资', amount: 1500, date: new Date(2026, 0, 5).getTime() });
    seedTx(db, { type: 'expense', name: '吃饭', amount: 600, date: new Date(2026, 0, 10).getTime() });

    const m = computeMonthMetrics(db, '2026-01');
    expect(m).not.toBeNull();
    expect(m!.income).toBe(1500);
    expect(m!.expense).toBe(600);
    expect(m!.net).toBe(900);
    // 上月 net = 600，本月 900，环比 = (900-600)/|600|*100 = 50
    expect(m!.momPct).toBeCloseTo(50, 6);
  });

  it('异常大额：单笔 > 月均 × 5 触发', () => {
    const cat = seedCategory(db, '吃饭');
    // 2026-01 内的 5 笔：100, 100, 100, 100, 500 → 月均 180；500 不够（< 180*5=900）
    seedTx(db, { type: 'expense', name: 'a', amount: 100, date: new Date(2026, 0, 3).getTime(), categoryId: cat });
    seedTx(db, { type: 'expense', name: 'b', amount: 100, date: new Date(2026, 0, 5).getTime(), categoryId: cat });
    seedTx(db, { type: 'expense', name: 'c', amount: 100, date: new Date(2026, 0, 8).getTime(), categoryId: cat });
    seedTx(db, { type: 'expense', name: 'd', amount: 100, date: new Date(2026, 0, 12).getTime(), categoryId: cat });
    seedTx(db, { type: 'expense', name: 'e', amount: 500, date: new Date(2026, 0, 18).getTime(), categoryId: cat });

    const m = computeMonthMetrics(db, '2026-01');
    // 期望月均 180；异常阈值 = 180 × 5 = 900；最高单笔 500 < 900 → 无异常
    expect(m!.anomalyLarge).toEqual([]);

    // 加大额单笔：再加 5000 → 月均 (100*4+500+5000)/7 = 500/7 ≈ 714 → 阈值 3571 → 5000 > 3571 ✓
    db.prepare('INSERT INTO transactions (type, name, amount, date, accountId, categoryId, includeInAsset, spaceId, createdAt) VALUES (?, ?, ?, ?, 1, ?, 1, 1, 1)').run(
      'expense', '超大额', 5000, new Date(2026, 0, 25).getTime(), cat,
    );
    const m2 = computeMonthMetrics(db, '2026-01');
    expect(m2!.anomalyLarge.length).toBeGreaterThan(0);
    expect(m2!.anomalyLarge[0].name).toBe('超大额');
  });

  it('预算告警：>= 80% 命中，包含 100%+ 的', () => {
    const cat = seedCategory(db, '餐饮');
    db.prepare(
      `INSERT INTO budgets (name, categoryId, amount, period, spaceId, createdAt)
       VALUES ('餐饮预算', ?, 1000, 'monthly', 1, 1)`,
    ).run(cat);
    seedTx(db, { type: 'expense', name: '吃饭', amount: 850, date: new Date(2026, 0, 5).getTime(), categoryId: cat });
    const m = computeMonthMetrics(db, '2026-01');
    expect(m!.budgetAlerts).toHaveLength(1);
    expect(m!.budgetAlerts[0].pct).toBeCloseTo(85, 6);
  });

  it('目标：30 天内截止的未完成目标', () => {
    db.prepare(
      `INSERT INTO goals (kind, name, targetAmount, currentAmount, deadline, spaceId, createdAt)
       VALUES ('saving', '旅行基金', 10000, 2000, ?, 1, 1)`,
    ).run(new Date(2026, 1, 15).getTime());
    // 注入 now=2026-01-10：30 天窗口覆盖 2026-01-10 ~ 2026-02-09
    // 但 deadline=2026-02-15 仍在"未来目标"分母（de 0 测试里放过期）。
    // 这里改用更近的 deadline 测 30 天窗口本身：
    db.prepare('DELETE FROM goals').run();
    db.prepare(
      `INSERT INTO goals (kind, name, targetAmount, currentAmount, deadline, spaceId, createdAt)
       VALUES ('saving', '旅行基金', 10000, 2000, ?, 1, 1)`,
    ).run(new Date(2026, 0, 25).getTime());
    const m = computeMonthMetrics(db, '2026-01', new Date(2026, 0, 5).getTime());
    expect(m!.goalsNear).toHaveLength(1);
    expect(m!.goalsNear[0].name).toBe('旅行基金');
  });
});