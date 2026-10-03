/**
 * 账户年收益率 REST 端点测试。
 *
 * 策略与 tests/api.test.ts 一致：
 *  - createApp({ skipBootstrap: true }) + app.listen(0) 拉真实 HTTP，原生 fetch
 *  - 数据库走 :memory:，每个用例自带一组账户，用 name 前缀隔离
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { setActiveDb } from '../src/routes/_db.js';

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

/** 直接建账户，绕开 POST 路由，快一点 */
function makeAccount(name: string, type: string, balance = 1000): number {
  const r = memDb
    .prepare(
      `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
       VALUES (?, ?, ?, 1, 1, 1, 1)`,
    )
    .run(name, type, balance);
  return Number(r.lastInsertRowid);
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
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try {
    memDb?.close();
  } catch {
    /* ignore */
  }
});

describe('REST /api/accounts 的 latestYield', () => {
  it('没填过收益率的账户 latestYield 为 null，账户字段一个不少', async () => {
    const id = makeAccount('y: 空账户', 'invest');
    const { status, data } = await http('/api/accounts');
    expect(status).toBe(200);
    const row = (data as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.latestYield).toBeNull();
    // 原有字段不能因为加了 latestYield 就少掉
    for (const key of ['id', 'name', 'type', 'balance', 'remark', 'tagIds', 'includeInNetAsset', 'spaceId', 'createdAt', 'updatedAt']) {
      expect(Object.keys(row as object)).toContain(key);
    }
    // 内部辅助列不能漏进 JSON
    expect(Object.keys(row as object)).not.toContain('latestYieldYear');
    expect(Object.keys(row as object)).not.toContain('latestYieldPercent');
  });

  it('latestYield 取年份最大的一条（不是最后写入的那条）', async () => {
    const id = makeAccount('y: 多年度', 'fund');
    // 故意乱序写入：2024 最后写
    for (const [year, yp] of [[2023, 1.1], [2024, 2.2], [2025, 3.3]] as const) {
      const r = await http(`/api/accounts/${id}/yields/${year}`, {
        method: 'PUT',
        body: { yieldPercent: yp },
      });
      expect(r.status).toBe(200);
    }
    const { data } = await http('/api/accounts');
    const row = (data as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(row?.latestYield).toEqual({ year: 2025, yieldPercent: 3.3 });
  });

  it('spaceId 过滤时 latestYield 同样附带', async () => {
    const id = makeAccount('y: 空间1', 'other');
    await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: -0.42 } });
    const { data } = await http('/api/accounts?spaceId=1');
    const row = (data as Array<Record<string, unknown>>).find((r) => r.id === id);
    expect(row?.latestYield).toEqual({ year: 2025, yieldPercent: -0.42 });
  });
});

describe('REST /api/accounts/:id/yields', () => {
  it('PUT 写入后 GET 按年份倒序返回 [{year, yieldPercent, note}]', async () => {
    const id = makeAccount('y: 历史', 'invest');
    for (const [year, yp, note] of [[2022, 1.5, 'a'], [2023, 1.6, null], [2024, 1.7, 'c']] as const) {
      const r = await http(`/api/accounts/${id}/yields/${year}`, {
        method: 'PUT',
        body: { yieldPercent: yp, ...(note === null ? {} : { note }) },
      });
      expect(r.status).toBe(200);
    }

    const { status, data } = await http(`/api/accounts/${id}/yields`);
    expect(status).toBe(200);
    expect(data).toEqual([
      { year: 2024, yieldPercent: 1.7, note: 'c' },
      { year: 2023, yieldPercent: 1.6, note: null },
      { year: 2022, yieldPercent: 1.5, note: 'a' },
    ]);
  });

  it('PUT 同一年是 upsert：只改数字，不新增行', async () => {
    const id = makeAccount('y: upsert', 'fund');
    await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: 1.0, note: '第一版' } });
    const second = await http(`/api/accounts/${id}/yields/2025`, {
      method: 'PUT',
      body: { yieldPercent: 1.9 },
    });
    expect(second.status).toBe(200);
    expect(second.data).toEqual({ year: 2025, yieldPercent: 1.9, note: null });

    const { data } = await http(`/api/accounts/${id}/yields`);
    expect(data).toHaveLength(1);
  });

  it('负收益（亏钱了）也能正常存', async () => {
    const id = makeAccount('y: 负收益', 'invest');
    const r = await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: -3.21 } });
    expect(r.status).toBe(200);
    const { data } = await http(`/api/accounts/${id}/yields`);
    expect(data).toEqual([{ year: 2025, yieldPercent: -3.21, note: null }]);
  });

  it('note 省略 / 空白串都落成 null', async () => {
    const id = makeAccount('y: note', 'fund');
    await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: 1 } });
    await http(`/api/accounts/${id}/yields/2024`, { method: 'PUT', body: { yieldPercent: 1, note: '   ' } });
    const { data } = await http(`/api/accounts/${id}/yields`);
    expect(data).toEqual([
      { year: 2025, yieldPercent: 1, note: null },
      { year: 2024, yieldPercent: 1, note: null },
    ]);
  });

  it('空列表：没填过就是 []', async () => {
    const id = makeAccount('y: 没填过', 'other');
    const { status, data } = await http(`/api/accounts/${id}/yields`);
    expect(status).toBe(200);
    expect(data).toEqual([]);
  });

  it('账户不存在 → 404', async () => {
    expect((await http('/api/accounts/999999/yields')).status).toBe(404);
    expect(
      (await http('/api/accounts/999999/yields/2025', { method: 'PUT', body: { yieldPercent: 1 } })).status,
    ).toBe(404);
  });

  it('id / year 非法 → 400', async () => {
    const id = makeAccount('y: 校验', 'fund');
    expect((await http('/api/accounts/abc/yields')).status).toBe(400);
    expect((await http('/api/accounts/0/yields')).status).toBe(400);
    for (const bad of ['abc', '0', '-1', '20250', '1969']) {
      const r = await http(`/api/accounts/${id}/yields/${bad}`, {
        method: 'PUT',
        body: { yieldPercent: 1 },
      });
      expect(r.status, `year=${bad}`).toBe(400);
    }
  });

  it('yieldPercent 缺失 / 非数字 → 400，且不落库', async () => {
    const id = makeAccount('y: 非法收益率', 'fund');
    expect(
      (await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: {} })).status,
    ).toBe(400);
    expect(
      (await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: 'abc' } })).status,
    ).toBe(400);
    expect(
      (await http(`/api/accounts/${id}/yields/2025`, { method: 'PUT', body: { yieldPercent: null } })).status,
    ).toBe(400);
    const { data } = await http(`/api/accounts/${id}/yields`);
    expect(data).toEqual([]);
  });
});
