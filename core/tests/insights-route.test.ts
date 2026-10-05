/**
 * core/src/routes/ai-insights.ts e2e 测试（与 yield-reminder-e2e 同构）：
 *  - createApp({ skipBootstrap: true }) + app.listen(0) + 原生 fetch 调用
 *  - 数据库走 :memory:；openDatabase + setActiveDb 注入路由层
 *  - afterAll 主动 close db（避免 better-sqlite3 native cleanup hook 与 isolate 退出竞态）
 *
 * 覆盖：
 *  - GET /api/ai-insights?status=pending 列表
 *  - GET /api/ai-insights/:id 单条详情
 *  - POST /:id/resolve & /:id/dismiss
 *  - POST /api/ai-insights/generate?month=YYYY-MM 手动触发；同月二次返回 reused；
 *    配额超出返回 429
 *  - 手动配额计数只算手动，不被自动调度影响
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { setActiveDb } from '../src/routes/_db.js';
import {
  AI_INSIGHT_TYPE,
  AI_INSIGHT_MANUAL_QUOTA,
  getManualCount,
} from '../src/insights/scheduler.js';

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

function seedModel(name = 'm1'): number {
  const r = memDb
    .prepare(
      `INSERT INTO aiModels (name, model, endpoint, apiKey) VALUES (?, 'gpt-4o-mini', 'https://api.example.com/v1', 'k')`,
    )
    .run(name);
  return Number(r.lastInsertRowid);
}

function seedAccountAndExpense(): void {
  memDb
    .prepare(
      `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
       VALUES ('现金', 'fund', 0, 1, 1, 1, 1)`,
    )
    .run();
  memDb
    .prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt)
       VALUES ('expense', '日常', 500, ?, 1, 1, 1, 1)`,
    )
    .run(new Date(2026, 0, 10).getTime());
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

beforeEach(() => {
  memDb.exec(
    `DELETE FROM notifications; DELETE FROM kv; DELETE FROM transactions; DELETE FROM accounts; DELETE FROM aiModels;`,
  );
});

describe('GET /api/ai-insights', () => {
  it('空库返回 []', async () => {
    const r = await http('/api/ai-insights?status=pending');
    expect(r.status).toBe(200);
    expect(r.data).toEqual([]);
  });

  it('非法 status → 400', async () => {
    const r = await http('/api/ai-insights?status=bogus');
    expect(r.status).toBe(400);
  });
});

describe('POST /api/ai-insights/generate?month=YYYY-MM', () => {
  it('未配置模型 → 200 + llmAttempted=false', async () => {
    seedAccountAndExpense();
    const r = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    expect(r.status).toBe(201);
    expect((r.data as { llmAttempted: boolean }).llmAttempted).toBe(false);
    expect((r.data as { reused: boolean }).reused).toBe(false);
  });

  it('手动配额（默认 3）超出 → 429', async () => {
    seedModel();
    seedAccountAndExpense();
    for (let i = 0; i < AI_INSIGHT_MANUAL_QUOTA; i++) {
      const r = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
      expect(r.status).toBe(201);
      // 跨过 dedupe 窗口：把上一条 createdAt 调到 30 天前
      const data = r.data as { id: number };
      const longAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
      memDb.prepare('UPDATE notifications SET createdAt = ?, updatedAt = ? WHERE id = ?').run(
        longAgo,
        longAgo,
        data.id,
      );
    }
    // 第 N+1 次：quota-exceeded
    const overflow = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    expect(overflow.status).toBe(429);
    expect(getManualCount(memDb, '2026-01')).toBe(AI_INSIGHT_MANUAL_QUOTA);
  });

  it('同月份已有且在窗口内 → 200 reused（不再产）', async () => {
    seedModel();
    seedAccountAndExpense();
    const r1 = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    expect(r1.status).toBe(201);
    const firstId = (r1.data as { id: number }).id;
    const r2 = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    expect(r2.status).toBe(200);
    const data2 = r2.data as { id: number; reused: boolean };
    expect(data2.reused).toBe(true);
    expect(data2.id).toBe(firstId);
  });

  it('非法 month → 400', async () => {
    const r = await http('/api/ai-insights/generate?month=bad', { method: 'POST' });
    expect(r.status).toBe(400);
  });
});

describe('GET /api/ai-insights/:id', () => {
  it('创建后能查到', async () => {
    seedModel();
    seedAccountAndExpense();
    const r = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    const id = (r.data as { id: number }).id;
    const detail = await http(`/api/ai-insights/${id}`);
    expect(detail.status).toBe(200);
    expect((detail.data as { type: string }).type).toBe(AI_INSIGHT_TYPE);
    expect(typeof (detail.data as { payload?: string }).payload).toBe('string');
  });

  it('非 ai-insight 类型的 id → 404（业务隔离）', async () => {
    memDb
      .prepare(
        `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
         VALUES ('现金', 'fund', 0, 1, 1, 1, 1)`,
      )
      .run();
    const r = memDb
      .prepare(
        `INSERT INTO notifications (type, title, status, createdAt, updatedAt)
         VALUES ('need_password', '密码', 'pending', 1, 1)`,
      )
      .run();
    const otherId = Number(r.lastInsertRowid);
    const res = await http(`/api/ai-insights/${otherId}`);
    expect(res.status).toBe(404);
  });

  it('非法 id → 400；不存在 → 404', async () => {
    expect((await http('/api/ai-insights/abc')).status).toBe(400);
    expect((await http('/api/ai-insights/0')).status).toBe(400);
    expect((await http('/api/ai-insights/9999')).status).toBe(404);
  });
});

describe('POST /:id/resolve & /:id/dismiss', () => {
  it('resolve 后 status=resolved', async () => {
    seedModel();
    seedAccountAndExpense();
    const r = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    const id = (r.data as { id: number }).id;
    const res = await http(`/api/ai-insights/${id}/resolve`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((res.data as { status: string }).status).toBe('resolved');
  });

  it('dismiss 后 status=dismissed', async () => {
    seedModel();
    seedAccountAndExpense();
    const r = await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    const id = (r.data as { id: number }).id;
    const res = await http(`/api/ai-insights/${id}/dismiss`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((res.data as { status: string }).status).toBe('dismissed');
  });

  it('非 ai-insight → 404；不存在 → 404；非法 id → 400', async () => {
    expect((await http('/api/ai-insights/9999/resolve', { method: 'POST' })).status).toBe(404);
    expect((await http('/api/ai-insights/abc/resolve', { method: 'POST' })).status).toBe(400);
    expect((await http('/api/ai-insights/0/dismiss', { method: 'POST' })).status).toBe(400);
  });
});

describe('配额计数：手动 vs 自动互不串扰', () => {
  it('手动触发才会 bump manualCount，自动调度不计入', async () => {
    seedModel();
    seedAccountAndExpense();
    expect(getManualCount(memDb, '2026-01')).toBe(0);
    await http('/api/ai-insights/generate?month=2026-01', { method: 'POST' });
    expect(getManualCount(memDb, '2026-01')).toBe(1);
  });
});