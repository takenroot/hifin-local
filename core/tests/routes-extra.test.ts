/**
 * 新增 REST 路由集成测试（goals / budgets / tags / merchants / rules / spaces / kv）
 *
 * 策略与 tests/api.test.ts 保持一致：
 *  - createApp({ skipBootstrap: true }) + app.listen(0) 拉起真实 HTTP，原生 fetch 调用
 *  - 数据库走 :memory:，openDatabase + migrate + setActiveDb 注入路由层
 *  - afterAll 主动 close db，规避 better-sqlite3 native cleanup hook 与 V8 isolate 退出竞态
 *
 * 用例之间共享同一个 :memory: 库，因此每个用例使用独立的资源名/空间 id，避免相互干扰。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureSeed } from '../src/db/seed.js';
import { setActiveDb } from '../src/routes/_db.js';

let app: import('express').Express;
let server: Server;
let baseUrl: string;
let memDb: import('better-sqlite3').Database;

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
  const data: unknown = text.length === 0 ? null : JSON.parse(text);
  return { status: res.status, data };
}

/** 读取指定账户当前余额（用于校验 goals 的余额联动）。 */
async function balanceOf(accountId: number): Promise<number> {
  const rows = (await http('/api/accounts')).data as Array<{
    id: number;
    balance: number;
  }>;
  const acc = rows.find((a) => a.id === accountId);
  if (!acc) throw new Error(`account ${accountId} not found`);
  return acc.balance;
}

/** 建一个测试用账户，返回其 id。 */
async function makeAccount(name: string, balance: number, spaceId?: number): Promise<number> {
  const { status, data } = await http('/api/accounts', {
    method: 'POST',
    body: { name, type: 'fund', balance, ...(spaceId !== undefined ? { spaceId } : {}) },
  });
  expect(status).toBe(201);
  return (data as { id: number }).id;
}

beforeAll(async () => {
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);
  // seed 会写入默认空间 id=1；不 seed 的话首个新建空间会占用 id=1，撞上"默认空间不可删"的保护
  ensureSeed(memDb);

  const { createApp } = await import('../src/server.js');
  app = createApp({ skipBootstrap: true });
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

describe('GET /api/goals', () => {
  it('CRUD 往返 + currentAmount 变化同步账户余额（saving 存入方向）', async () => {
    const accountId = await makeAccount('目标测试账户', 1000);
    expect(await balanceOf(accountId)).toBeCloseTo(1000, 5);

    // 1) 创建目标，currentAmount=200 视为往账户存入 200
    const created = await http('/api/goals', {
      method: 'POST',
      body: {
        kind: 'saving',
        name: '旅行基金',
        targetAmount: 5000,
        currentAmount: 200,
        accountId,
      },
    });
    expect(created.status).toBe(201);
    const goal = created.data as {
      id: number;
      name: string;
      currentAmount: number;
      accountId: number;
    };
    expect(goal.id).toBeGreaterThan(0);
    expect(goal.accountId).toBe(accountId);
    expect(await balanceOf(accountId)).toBeCloseTo(1200, 5);

    // 2) 列表能查到
    const list = (await http('/api/goals')).data as Array<{ id: number; name: string }>;
    expect(list.find((g) => g.id === goal.id)?.name).toBe('旅行基金');

    // 3) 更新 currentAmount 200 → 500，余额再 +300
    const updated = await http(`/api/goals/${goal.id}`, {
      method: 'PUT',
      body: { currentAmount: 500, name: '旅行基金 2024' },
    });
    expect(updated.status).toBe(200);
    expect((updated.data as { currentAmount: number }).currentAmount).toBe(500);
    expect(await balanceOf(accountId)).toBeCloseTo(1500, 5);

    // 4) 删除目标，余额贡献被回滚到初始值
    const del = await http(`/api/goals/${goal.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(await balanceOf(accountId)).toBeCloseTo(1000, 5);

    // 5) 已删除 → 404
    expect((await http(`/api/goals/${goal.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('repayment 方向相反 + 空间过滤 + 参数校验', async () => {
    const accountId = await makeAccount('还债测试账户', 5000);

    const created = await http('/api/goals', {
      method: 'POST',
      body: {
        kind: 'repayment',
        name: '房贷',
        targetAmount: 100000,
        currentAmount: 1000,
        accountId,
        spaceId: 99,
      },
    });
    expect(created.status).toBe(201);
    const goal = created.data as { id: number };
    // repayment：currentAmount 上升 = 账户还款支出 → 余额 -1000
    expect(await balanceOf(accountId)).toBeCloseTo(4000, 5);

    // 空间过滤：只返回 spaceId=99 的目标
    const inSpace = (await http('/api/goals?spaceId=99')).data as Array<{ id: number }>;
    expect(inSpace.some((g) => g.id === goal.id)).toBe(true);
    const outSpace = (await http('/api/goals?spaceId=7')).data as Array<{ id: number }>;
    expect(outSpace.some((g) => g.id === goal.id)).toBe(false);

    // 非法 kind → 400
    expect(
      (await http('/api/goals', { method: 'POST', body: { kind: 'nope', name: 'x' } })).status,
    ).toBe(400);
    // 非法 spaceId → 400
    expect((await http('/api/goals?spaceId=abc')).status).toBe(400);
    // accountId 不存在 → 400，且目标未被创建（事务回滚）
    const badAcc = await http('/api/goals', {
      method: 'POST',
      body: { kind: 'saving', name: '坏账户', currentAmount: 50, accountId: 999999 },
    });
    expect(badAcc.status).toBe(400);
    expect(await balanceOf(accountId)).toBeCloseTo(4000, 5);

    // 清理：删除目标后余额回到 5000
    expect((await http(`/api/goals/${goal.id}`, { method: 'DELETE' })).status).toBe(204);
    expect(await balanceOf(accountId)).toBeCloseTo(5000, 5);
  });
});

describe('/api/budgets', () => {
  it('CRUD 往返 + 空间过滤', async () => {
    const created = await http('/api/budgets', {
      method: 'POST',
      body: { name: '餐饮月预算', amount: 2000, period: 'monthly', spaceId: 88 },
    });
    expect(created.status).toBe(201);
    const budget = created.data as {
      id: number;
      name: string;
      amount: number;
      period: string;
      spaceId: number;
    };
    expect(budget.amount).toBe(2000);
    expect(budget.period).toBe('monthly');
    expect(budget.spaceId).toBe(88);

    const inSpace = (await http('/api/budgets?spaceId=88')).data as Array<{ id: number }>;
    expect(inSpace.some((b) => b.id === budget.id)).toBe(true);

    const updated = await http(`/api/budgets/${budget.id}`, {
      method: 'PUT',
      body: { amount: 2500, period: 'yearly' },
    });
    expect(updated.status).toBe(200);
    expect((updated.data as { amount: number }).amount).toBe(2500);
    expect((updated.data as { period: string }).period).toBe('yearly');

    // 非法 period → 400
    expect(
      (await http('/api/budgets', { method: 'POST', body: { name: 'x', amount: 1, period: 'weekly' } }))
        .status,
    ).toBe(400);

    expect((await http(`/api/budgets/${budget.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http(`/api/budgets/${budget.id}`, { method: 'PUT', body: { amount: 1 } })).status).toBe(
      404,
    );
  });
});

describe('/api/tags', () => {
  it('CRUD 往返 + 重名 409', async () => {
    const created = await http('/api/tags', {
      method: 'POST',
      body: { name: '出差', color: '#ff0000' },
    });
    expect(created.status).toBe(201);
    const tag = created.data as { id: number; name: string; color: string };
    expect(tag.color).toBe('#ff0000');

    // 重名 → 409
    const dup = await http('/api/tags', { method: 'POST', body: { name: '出差' } });
    expect(dup.status).toBe(409);

    // 搜索
    const found = (await http('/api/tags?q=出')).data as Array<{ id: number }>;
    expect(found.some((t) => t.id === tag.id)).toBe(true);

    const updated = await http(`/api/tags/${tag.id}`, {
      method: 'PUT',
      body: { name: '出差报销', color: '#00ff00' },
    });
    expect(updated.status).toBe(200);
    expect((updated.data as { name: string }).name).toBe('出差报销');
    expect((updated.data as { color: string }).color).toBe('#00ff00');

    expect((await http(`/api/tags/${tag.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http(`/api/tags/${tag.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('/api/merchants', () => {
  it('CRUD 往返 + 搜索', async () => {
    const created = await http('/api/merchants', {
      method: 'POST',
      body: { name: '星巴克', remark: '常去' },
    });
    expect(created.status).toBe(201);
    const merchant = created.data as { id: number; name: string; remark: string };
    expect(merchant.remark).toBe('常去');

    const found = (await http('/api/merchants?q=巴克')).data as Array<{ id: number }>;
    expect(found.some((m) => m.id === merchant.id)).toBe(true);

    const updated = await http(`/api/merchants/${merchant.id}`, {
      method: 'PUT',
      body: { remark: '已改' },
    });
    expect(updated.status).toBe(200);
    expect((updated.data as { remark: string }).remark).toBe('已改');

    expect((await http(`/api/merchants/${merchant.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http(`/api/merchants/999999`, { method: 'PUT', body: { remark: 'x' } })).status).toBe(
      404,
    );
  });
});

describe('/api/rules', () => {
  it('CRUD 往返 + enabled 过滤', async () => {
    const created = await http('/api/rules', {
      method: 'POST',
      body: { keyword: '咖啡', matchField: 'name', categoryId: 1, priority: 10 },
    });
    expect(created.status).toBe(201);
    const rule = created.data as {
      id: number;
      keyword: string;
      matchField: string;
      priority: number;
      enabled: number;
    };
    expect(rule.enabled).toBe(1);
    expect(rule.priority).toBe(10);

    // 非法 matchField → 400
    expect(
      (
        await http('/api/rules', {
          method: 'POST',
          body: { keyword: 'x', matchField: 'amount', categoryId: 1 },
        })
      ).status,
    ).toBe(400);
    // 缺 categoryId → 400
    expect(
      (await http('/api/rules', { method: 'POST', body: { keyword: 'x', matchField: 'name' } })).status,
    ).toBe(400);

    const updated = await http(`/api/rules/${rule.id}`, {
      method: 'PUT',
      body: { enabled: false, priority: 99 },
    });
    expect(updated.status).toBe(200);
    expect((updated.data as { enabled: number }).enabled).toBe(0);
    expect((updated.data as { priority: number }).priority).toBe(99);

    const enabledOnly = (await http('/api/rules?enabled=true')).data as Array<{ id: number }>;
    expect(enabledOnly.some((r) => r.id === rule.id)).toBe(false);
    const disabledOnly = (await http('/api/rules?enabled=0')).data as Array<{ id: number }>;
    expect(disabledOnly.some((r) => r.id === rule.id)).toBe(true);
    // 非法 enabled → 400
    expect((await http('/api/rules?enabled=maybe')).status).toBe(400);

    expect((await http(`/api/rules/${rule.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http(`/api/rules/${rule.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('/api/spaces', () => {
  it('CRUD 往返 + 非空空间拒绝删除', async () => {
    const created = await http('/api/spaces', { method: 'POST', body: { name: '测试空间' } });
    expect(created.status).toBe(201);
    const space = created.data as { id: number; name: string; counts: Record<string, number> };
    expect(space.counts.accounts).toBe(0);

    // 重名 → 409
    expect(
      (await http('/api/spaces', { method: 'POST', body: { name: '测试空间' } })).status,
    ).toBe(409);

    const renamed = await http(`/api/spaces/${space.id}`, {
      method: 'PUT',
      body: { name: '测试空间 2' },
    });
    expect(renamed.status).toBe(200);
    expect((renamed.data as { name: string }).name).toBe('测试空间 2');

    // 默认空间 id=1 不可删除
    expect((await http('/api/spaces/1', { method: 'DELETE' })).status).toBe(409);

    // 往该空间塞一个账户 → 空间非空 → 409
    await makeAccount('空间内账户', 100, space.id);
    const nonEmpty = await http(`/api/spaces/${space.id}`, { method: 'DELETE' });
    expect(nonEmpty.status).toBe(409);
    expect((nonEmpty.data as { error: string }).error).toContain('非空');

    // 空间仍在列表里
    const list = (await http('/api/spaces')).data as Array<{ id: number; counts: Record<string, number> }>;
    const s = list.find((x) => x.id === space.id);
    expect(s?.counts.accounts).toBe(1);

    // 清理关联数据后再删
    const accRows = (await http(`/api/accounts?spaceId=${space.id}`)).data as Array<{ id: number }>;
    for (const acc of accRows) {
      await http(`/api/accounts/${acc.id}`, { method: 'DELETE' });
    }
    expect((await http(`/api/spaces/${space.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await http(`/api/spaces/${space.id}`, { method: 'DELETE' })).status).toBe(404);
  });
});

describe('/api/kv/:key', () => {
  it('PUT/GET/DELETE 往返，value 为任意 JSON 且支持 upsert', async () => {
    // 不存在 → 404
    expect((await http('/api/kv/nope')).status).toBe(404);

    const put1 = await http('/api/kv/lastSyncAt', {
      method: 'PUT',
      body: { value: { at: 1710000000000, count: 3 } },
    });
    expect(put1.status).toBe(200);
    expect((put1.data as { key: string; value: { count: number } }).key).toBe('lastSyncAt');
    expect((put1.data as { value: { count: number } }).value.count).toBe(3);

    const got = await http('/api/kv/lastSyncAt');
    expect(got.status).toBe(200);
    expect((got.data as { value: { at: number } }).value.at).toBe(1710000000000);

    // 再次 PUT → upsert 覆盖而非新增
    const put2 = await http('/api/kv/lastSyncAt', {
      method: 'PUT',
      body: { value: [1, 2, 3] },
    });
    expect(put2.status).toBe(200);
    const gotAgain = (await http('/api/kv/lastSyncAt')).data as { value: number[] };
    expect(Array.isArray(gotAgain.value)).toBe(true);
    expect(gotAgain.value).toEqual([1, 2, 3]);

    // 标量 value 也能存取
    const put3 = await http('/api/kv/uiTheme', { method: 'PUT', body: { value: 'dark' } });
    expect(put3.status).toBe(200);
    expect(((await http('/api/kv/uiTheme')).data as { value: string }).value).toBe('dark');

    expect((await http('/api/kv/lastSyncAt', { method: 'DELETE' })).status).toBe(204);
    expect((await http('/api/kv/lastSyncAt')).status).toBe(404);
    // 重复删除 → 404
    expect((await http('/api/kv/lastSyncAt', { method: 'DELETE' })).status).toBe(404);
    expect((await http('/api/kv/uiTheme', { method: 'DELETE' })).status).toBe(204);
  });
});
