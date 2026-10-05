/**
 * core/src/insights/scheduler.ts 单测。
 *
 * 覆盖三个不变量：
 *  1. 同月份已有 ai-insight → skippedReason='dedupe'（不重生）
 *  2. 无 aiModels → llmAttempted=false（遵守"本地默认关闭"）
 *  3. 手动配额超出 → quota-exceeded
 *  4. 立刻 + 24h + unref() 的 server.ts 接线
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import {
  ensureMonthlyInsight,
  ensureManualInsight,
  AI_INSIGHT_INTERVAL_MS,
  AI_INSIGHT_MANUAL_QUOTA,
  AI_INSIGHT_TYPE,
  pickDefaultModel,
  currentMonth,
  getManualCount,
  renderRuleNarrative,
} from '../src/insights/scheduler.js';
import {
  startAiInsightScheduler,
  AI_INSIGHT_INTERVAL_MS as SCHED_INTERVAL,
} from '../src/insights/scheduler.js';
import { listNotifications, parseNotificationPayload } from '../src/notifications/store.js';

function freshDb(): Database.Database {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

function seedAiModel(db: Database.Database, name = 'test-model'): number {
  const r = db
    .prepare(
      `INSERT INTO aiModels (name, model, endpoint, apiKey) VALUES (?, 'gpt-4o-mini', 'https://api.example.com/v1/chat/completions', 'k')`,
    )
    .run(name);
  return Number(r.lastInsertRowid);
}

function seedIncomeAndExpense(db: Database.Database, month: string, income = 5000, expense = 3000): void {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return;
  const y = Number(m[1]);
  const mo = Number(m[2]) - 1;
  db.prepare(`INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt) VALUES ('现金', 'fund', 0, 1, 1, 1, 1)`).run();
  db.prepare(
    `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt)
     VALUES ('income', '工资', ?, ?, 1, 1, 1, 1)`,
  ).run(income, new Date(y, mo, 5).getTime());
  db.prepare(
    `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt)
     VALUES ('expense', '日常', ?, ?, 1, 1, 1, 1)`,
  ).run(expense, new Date(y, mo, 10).getTime());
}

function insightRows(db: Database.Database): Array<{ id: number; status: string; payload: string | null }> {
  return db
    .prepare(`SELECT id, status, payload FROM notifications WHERE type = ? ORDER BY id`)
    .all(AI_INSIGHT_TYPE) as Array<{ id: number; status: string; payload: string | null }>;
}

let db: Database.Database;
beforeEach(() => {
  db?.close?.();
  db = freshDb();
  vi.useRealTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ensureMonthlyInsight：自动调度', () => {
  it('无 aiModels → llmAttempted=false 且仍落一条规则版通知', () => {
    seedIncomeAndExpense(db, '2026-01');
    const run = ensureMonthlyInsight(db, new Date(2026, 1, 1)); // 2 月 1 日 → 生成 1 月报告
    expect(run.generated).toBe(1);
    expect(run.llmAttempted).toBe(false);
    expect(run.skippedReason).toBe('no-model');
    expect(insightRows(db)).toHaveLength(1);
  });

  it('有 aiModels → llmAttempted=true', () => {
    seedAiModel(db);
    seedIncomeAndExpense(db, '2026-01');
    // 阻止真实的 fetch（测试不需要真模型响应）
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('should not reach fetch in this test');
      }),
    );
    try {
      const run = ensureMonthlyInsight(db, new Date(2026, 1, 1));
      expect(run.generated).toBe(1);
      expect(run.llmAttempted).toBe(true);
      // LLM fetch 失败被吞，规则版通知仍存在
      expect(insightRows(db)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('同月份二次跑 → skippedReason=dedupe（不重生通知）', () => {
    seedIncomeAndExpense(db, '2026-01');
    const first = ensureMonthlyInsight(db, new Date()); // 用"现在"以确保 createdAt 在 dedupe 窗口内
    expect(first.generated).toBe(1);
    const second = ensureMonthlyInsight(db, new Date());
    expect(second.generated).toBe(0);
    expect(second.skippedReason).toBe('dedupe');
    expect(second.reused).toBe(first.notificationId);
    expect(insightRows(db)).toHaveLength(1);
  });

  it('窗口外（> 7 天）允许重新生成：把同月份最近一条的 createdAt 调到 30 天前', () => {
    seedIncomeAndExpense(db, '2026-01');
    const run0 = ensureMonthlyInsight(db, new Date(Date.now() + 0)); // 用"现在"作为运行时刻
    const id = run0.notificationId as number;
    const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE notifications SET createdAt = ?, updatedAt = ? WHERE id = ?').run(
      longAgo,
      longAgo,
      id,
    );
    const run1 = ensureMonthlyInsight(db, new Date());
    expect(run1.generated).toBe(1);
    expect(insightRows(db)).toHaveLength(2);
  });

  it('currentMonth 输出 YYYY-MM 形式（padStart）', () => {
    expect(currentMonth(new Date(2026, 0, 1))).toBe('2026-01');
    expect(currentMonth(new Date(2026, 9, 31))).toBe('2026-10');
  });

  it('pickDefaultModel：第一条 + kv 覆盖', () => {
    const id1 = seedAiModel(db, 'A');
    const id2 = seedAiModel(db, 'B');
    expect(pickDefaultModel(db)?.id).toBe(id1);
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
      'ai.defaultModelId',
      JSON.stringify(id2),
    );
    expect(pickDefaultModel(db)?.id).toBe(id2);
    // 覆盖了一个不存在的 id → 回退到第一条
    db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
      'ai.defaultModelId',
      JSON.stringify(9999),
    );
    expect(pickDefaultModel(db)?.id).toBe(id1);
  });
});

describe('ensureManualInsight：手动触发', () => {
  it('配额递增 + 第 N+1 次 quota-exceeded', () => {
    seedAiModel(db);
    seedIncomeAndExpense(db, '2026-01');
    // 把 dedupe 窗口错开：每次跑都把上一条的 createdAt 调到 30 天前
    for (let i = 0; i < AI_INSIGHT_MANUAL_QUOTA; i++) {
      const r = ensureManualInsight(db, new Date(), '2026-01');
      expect(r.generated).toBe(1);
      db.prepare(
        `UPDATE notifications SET createdAt = ?, updatedAt = ? WHERE id = ?`,
      ).run(Date.now() - 30 * 24 * 60 * 60 * 1000, Date.now(), r.notificationId);
    }
    // 配额已用完 → 第四次（含）应该全部 quota-exceeded
    const overflow = ensureManualInsight(db, new Date(), '2026-01');
    expect(overflow.generated).toBe(0);
    expect(overflow.skippedReason).toBe('quota-exceeded');
    expect(getManualCount(db, '2026-01')).toBe(AI_INSIGHT_MANUAL_QUOTA);
  });

  it('同月份已有且在去重窗口内 → 复用（200 reused）', () => {
    seedAiModel(db);
    seedIncomeAndExpense(db, '2026-01');
    const first = ensureManualInsight(db, new Date(2026, 1, 1), '2026-01');
    const second = ensureManualInsight(db, new Date(2026, 1, 1, 1, 0, 0), '2026-01');
    expect(second.generated).toBe(0);
    expect(second.reused).toBe(first.notificationId);
  });
});

describe('renderRuleNarrative：payload 形态', () => {
  it('空指标：sections 至少含「收支」段，summary 不爆 200 字', () => {
    const r = renderRuleNarrative({
      month: '2026-01',
      income: 0,
      expense: 0,
      net: 0,
      momPct: null,
      topExpense: [],
      topExpenseMom: [],
      largest: null,
      budgetAlerts: [],
      goalsNear: [],
      anomalyLarge: [],
    });
    expect(r.summary.length).toBeLessThanOrEqual(200);
    expect(r.sections[0].title).toBe('收支');
  });

  it('完整指标：summary 含关键数字、sections 含每个分类', () => {
    const r = renderRuleNarrative({
      month: '2026-01',
      income: 5000,
      expense: 3000,
      net: 2000,
      momPct: 50,
      topExpense: [
        { categoryId: 1, name: '餐饮', icon: '🍱', amount: 1500, pct: 50 },
      ],
      topExpenseMom: [],
      largest: { name: '大餐', amount: 500, date: 1 },
      budgetAlerts: [{ name: '餐饮预算', spent: 1500, amount: 2000, pct: 75 }],
      goalsNear: [],
      anomalyLarge: [{ name: '超大额', amount: 5000, date: 2, ratioToAvg: 10 }],
    });
    expect(r.summary).toContain('2026-01');
    expect(r.summary).toContain('5000');
    expect(r.summary).toContain('3000');
    expect(r.summary.length).toBeLessThanOrEqual(200);
    expect(r.sections.some((s) => s.title === '预算告警')).toBe(true);
  });
});

describe('startAiInsightScheduler：server.ts 接线', () => {
  it('默认周期是 24h', () => {
    expect(SCHED_INTERVAL).toBe(AI_INSIGHT_INTERVAL_MS);
    expect(AI_INSIGHT_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('启动即跑一次 + timer unref', () => {
    seedIncomeAndExpense(db, '2026-01');
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 1, 1));
    const timer = startAiInsightScheduler(db, 60_000);
    expect(insightRows(db)).toHaveLength(1); // 立刻跑了
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });

  it('单次跑挂掉只 log，不抛给调用方', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const broken = openDatabase(':memory:');
      broken.close();
      expect(() => startAiInsightScheduler(broken, 60_000)).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('parseNotificationPayload 兼容 ai-insight 字段', () => {
  it('新落的通知 payload 是合法 JSON，含 llmNarrative=null 与 source', () => {
    seedIncomeAndExpense(db, '2026-01');
    ensureMonthlyInsight(db, new Date(2026, 1, 1));
    const row = listNotifications(db, { type: AI_INSIGHT_TYPE })[0];
    expect(row).toBeDefined();
    const payload = parseNotificationPayload(row);
    expect(payload).not.toBeNull();
    expect(payload?.summary).toContain('2026-01');
    expect(payload?.source).toBe('auto');
    expect(payload?.llmNarrative).toBeNull();
  });
});