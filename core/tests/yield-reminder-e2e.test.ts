/**
 * 催填调度器的端到端串联 + server.ts 接线测试。
 *
 * 这里只放"跨模块才能证明"的东西：
 *  - 调度器建通知 → REST 补填 → 通知自动 resolved（写入即消提醒）
 *  - startYieldReminderScheduler 启动即跑一次、24h 周期、异常不冒泡、不吊住进程
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { setActiveDb } from '../src/routes/_db.js';
import { startYieldReminderScheduler, YIELD_REMINDER_INTERVAL_MS } from '../src/server.js';
import {
  ensureYieldReminders,
  YIELD_REMINDER_TYPE,
} from '../src/yields/reminder.js';

let memDb: Database.Database;
let server: Server;
let baseUrl: string;

async function http(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text.length === 0 ? null : JSON.parse(text) };
}

function pendingReminders(): Array<{ id: number; payload: string }> {
  return memDb
    .prepare("SELECT id, payload FROM notifications WHERE type = ? AND status = 'pending' ORDER BY id")
    .all(YIELD_REMINDER_TYPE) as Array<{ id: number; payload: string }>;
}

beforeAll(async () => {
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);
  const { createApp } = await import('../src/server.js');
  const app = createApp({ skipBootstrap: true });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try {
    memDb?.close();
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  vi.useRealTimers();
  memDb.exec("DELETE FROM notifications; DELETE FROM accountYields; DELETE FROM accounts;");
});

describe('端到端：调度器 ↔ REST 补填', () => {
  it('1 月调度建提醒 → REST 补填 → 通知当场 resolved → 不再是待办', async () => {
    const r = memDb
      .prepare(
        `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
         VALUES ('零钱通', 'invest', 960, 1, 1, 1, 1)`,
      )
      .run();
    const accountId = Number(r.lastInsertRowid);

    // 1）1 月跑调度 → 建出提醒
    const run = ensureYieldReminders(memDb, new Date(2026, 0, 3));
    expect(run.created).toBe(1);
    expect(pendingReminders()).toHaveLength(1);
    expect(JSON.parse(pendingReminders()[0].payload)).toEqual({ accountId, year: 2025 });

    // 2）用户在前端填了 2025 年的收益率
    const put = await http(`/api/accounts/${accountId}/yields/2025`, {
      method: 'PUT',
      body: { yieldPercent: 1.83, note: '零钱通年报' },
    });
    expect(put.status).toBe(200);

    // 3）通知**当场**被解决（不用等下一次 24h 调度）
    expect(pendingReminders()).toHaveLength(0);
    const row = memDb
      .prepare("SELECT status FROM notifications WHERE type = ?")
      .get(YIELD_REMINDER_TYPE) as { status: string };
    expect(row.status).toBe('resolved');

    // 4）账户列表带上 latestYield
    const list = await http('/api/accounts');
    const acc = (list.data as Array<Record<string, unknown>>).find((x) => x.id === accountId);
    expect(acc?.latestYield).toEqual({ year: 2025, yieldPercent: 1.83 });

    // 5）补填之后再跑调度，也不会被重新拉回 pending
    expect(ensureYieldReminders(memDb, new Date(2026, 0, 20)).resolved).toBe(0);
    expect(pendingReminders()).toHaveLength(0);
  });

  it('不填：2 月调度把它收成 expired，前端轮询不再看到', async () => {
    memDb
      .prepare(
        `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
         VALUES ('余额宝', 'fund', 5000, 1, 1, 1, 1)`,
      )
      .run();
    ensureYieldReminders(memDb, new Date(2026, 0, 3));

    const run = ensureYieldReminders(memDb, new Date(2026, 1, 1));
    expect(run.expired).toBe(1);
    // 前端就是靠 GET /api/notifications?status=pending 拉待办的
    const { data } = await http(`/api/notifications?status=pending&type=${YIELD_REMINDER_TYPE}`);
    expect(data).toEqual([]);
    const row = memDb
      .prepare('SELECT status FROM notifications WHERE type = ?')
      .get(YIELD_REMINDER_TYPE) as { status: string };
    expect(row.status).toBe('expired');
  });
});

describe('server.ts：startYieldReminderScheduler 接线', () => {
  it('启动时立刻跑一次，之后每 24h 跑一次', () => {
    memDb
      .prepare(
        `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
         VALUES ('零钱通', 'invest', 100, 1, 1, 1, 1)`,
      )
      .run();

    // 假时钟同时接管 new Date()（调度器取当前时间）和 setInterval
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 5, 8, 0));

    const timer = startYieldReminderScheduler(memDb, 1000);
    // 同步跑完第一轮：不 advanceTimersByTime 也能看到
    expect(pendingReminders()).toHaveLength(1);

    // 再推两个周期：仍然只有一条（去重生效）
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    expect(pendingReminders()).toHaveLength(1);

    // 跳到 2 月 1 日：兜底过期
    vi.setSystemTime(new Date(2026, 1, 1, 0, 30));
    vi.advanceTimersByTime(1000);
    expect(pendingReminders()).toHaveLength(0);
    const row = memDb
      .prepare('SELECT status FROM notifications WHERE type = ?')
      .get(YIELD_REMINDER_TYPE) as { status: string };
    expect(row.status).toBe('expired');

    clearInterval(timer);
  });

  it('默认周期就是 24 小时', () => {
    expect(YIELD_REMINDER_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
  });

  it('定时器已 unref，不会吊住进程退出（也不会在测试里留悬挂句柄）', () => {
    const timer = startYieldReminderScheduler(memDb, 60_000);
    expect(typeof timer.hasRef).toBe('function');
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });

  it('单次跑挂掉只打日志，不抛给调用方（不能把 HTTP 服务带崩）', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // 拿一个已关闭的连接当"坏 db"
      const broken = openDatabase(':memory:');
      broken.close();
      expect(() => startYieldReminderScheduler(broken, 60_000)).not.toThrow();
      expect(errSpy).toHaveBeenCalled();
      expect(String(errSpy.mock.calls[0]?.[0])).toContain('[yields]');
    } finally {
      errSpy.mockRestore();
    }
  });
});
