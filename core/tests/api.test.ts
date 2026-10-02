/**
 * hifin-core REST API 集成测试
 *
 * 策略：
 *  - 用 createApp() + app.listen(0)（随机端口）拉起真实 HTTP
 *  - 原生 fetch 调用
 *  - 数据库走 :memory:（避免污染磁盘）
 *  - 每个测试在 beforeAll 里 openDatabase(':memory:')、迁移 + seed
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

beforeAll(async () => {
  // 在 :memory: 上创建独立 db，绕开 connection.ts 的默认文件路径
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);
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
  // 主动关闭 db，避免 better-sqlite3 native 清理 hook 与 V8 isolate 退出顺序冲突
  try {
    memDb?.close();
  } catch {
    /* ignore */
  }
});

describe('REST API', () => {
  it('health', async () => {
    const { status, data } = await http('/api/health');
    expect(status).toBe(200);
    expect((data as { ok: boolean }).ok).toBe(true);
  });

  it('POST /api/accounts → 创建并出现在列表', async () => {
    const create = await http('/api/accounts', {
      method: 'POST',
      body: { name: '招商银行', type: 'fund', balance: 1000 },
    });
    expect(create.status).toBe(201);
    const acc = create.data as { id: number; name: string; balance: number };
    expect(acc.id).toBeGreaterThan(0);
    expect(acc.name).toBe('招商银行');
    expect(acc.balance).toBe(1000);

    const list = await http('/api/accounts');
    expect(list.status).toBe(200);
    const rows = list.data as Array<{ id: number; name: string }>;
    expect(rows.find((r) => r.id === acc.id)).toBeTruthy();
  });

  it('POST /api/transactions expense → 账户余额减少', async () => {
    // 先建账户
    const acc = (await http('/api/accounts', {
      method: 'POST',
      body: { name: '支付宝', type: 'fund', balance: 500 },
    })).data as { id: number; balance: number };
    expect(acc.balance).toBe(500);

    // 建一笔支出 38
    const tx = (await http('/api/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        name: '星巴克',
        amount: 38,
        accountId: acc.id,
        date: Date.now(),
      },
    })).data as { id: number; amount: number };

    // 校验账户余额：500 - 38 = 462
    const accAfter = (await http(`/api/accounts?spaceId=1`)).data as Array<{
      id: number;
      balance: number;
    }>;
    const a = accAfter.find((x) => x.id === acc.id);
    expect(a?.balance).toBeCloseTo(462, 5);

    // 校验 summary
    const today = new Date();
    const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
    const sum = (await http(`/api/summary?month=${month}`)).data as {
      monthIncome: number;
      monthExpense: number;
      monthNet: number;
      netAsset: number;
    };
    expect(sum.monthExpense).toBeCloseTo(38, 5);
    expect(sum.monthIncome).toBe(0);
    expect(sum.monthNet).toBeCloseTo(-38, 5);
    // 净资产：500 - 38 - 1000（之前建的那个账户 1000）=-538
    // 但因为是 in-memory 共享，这里不再做精确值断言，只校验净流向 = -38
    expect(sum.monthNet).toBeCloseTo(-38, 5);
  });

  it('PUT /api/transactions/:id → 回滚旧值 + 应用新值', async () => {
    const acc = (await http('/api/accounts', {
      method: 'POST',
      body: { name: '现金', type: 'fund', balance: 200 },
    })).data as { id: number };

    const tx = (await http('/api/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        name: '午餐',
        amount: 30,
        accountId: acc.id,
        date: Date.now(),
      },
    })).data as { id: number };

    // 余额现在是 170
    let accAfter = (await http('/api/accounts')).data as Array<{ id: number; balance: number }>;
    expect(accAfter.find((a) => a.id === acc.id)?.balance).toBeCloseTo(170, 5);

    // 改为 amount=50
    await http(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      body: { amount: 50 },
    });
    accAfter = (await http('/api/accounts')).data as Array<{ id: number; balance: number }>;
    expect(accAfter.find((a) => a.id === acc.id)?.balance).toBeCloseTo(150, 5);

    // 改为 income（余额应回滚 expense 的 -50 → +50，再加 income +80 = 200 + 80 = 280）
    await http(`/api/transactions/${tx.id}`, {
      method: 'PUT',
      body: { type: 'income', amount: 80 },
    });
    accAfter = (await http('/api/accounts')).data as Array<{ id: number; balance: number }>;
    expect(accAfter.find((a) => a.id === acc.id)?.balance).toBeCloseTo(280, 5);
  });

  it('DELETE /api/transactions/:id → 余额回滚', async () => {
    const acc = (await http('/api/accounts', {
      method: 'POST',
      body: { name: '微信钱包', type: 'fund', balance: 100 },
    })).data as { id: number };

    const tx = (await http('/api/transactions', {
      method: 'POST',
      body: {
        type: 'expense',
        name: '奶茶',
        amount: 25,
        accountId: acc.id,
        date: Date.now(),
      },
    })).data as { id: number };

    let accAfter = (await http('/api/accounts')).data as Array<{ id: number; balance: number }>;
    expect(accAfter.find((a) => a.id === acc.id)?.balance).toBeCloseTo(75, 5);

    const del = await http(`/api/transactions/${tx.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);

    accAfter = (await http('/api/accounts')).data as Array<{ id: number; balance: number }>;
    expect(accAfter.find((a) => a.id === acc.id)?.balance).toBeCloseTo(100, 5);
  });

  it('GET /api/categories', async () => {
    const { status, data } = await http('/api/categories');
    expect(status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
  });
});
