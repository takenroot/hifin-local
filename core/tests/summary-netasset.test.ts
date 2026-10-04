/**
 * /api/summary 净资产口径测试（ISSUE-005）
 *
 * 背景：calcNetAsset 曾对 credit/debt 一律 debt += Math.abs(balance)，把
 * "多还了钱/退款在途"的正余额当欠款，净资产凭空少 2×该金额。实测花呗
 * +139.29 → 看板 -28,515.67 vs Σ账户余额 -28,237.09，差 278.58。
 *
 * 这里钉住两件事：
 *   1. 纯函数口径（summaryHelpers.calcNetAsset）——与 app 侧同一份约定
 *   2. HTTP 口径：GET /api/summary 的 netAsset 恒等于 Σ 计入账户的余额
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccountRow } from '../src/db/schema.js';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureSeed } from '../src/db/seed.js';
import { setActiveDb } from '../src/routes/_db.js';
import { summaryHelpers } from '../src/routes/summary.js';

const { calcNetAsset } = summaryHelpers;

function acc(over: Partial<AccountRow>): AccountRow {
  return {
    name: '测试账户',
    type: 'fund',
    balance: 0,
    includeInNetAsset: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('summaryHelpers.calcNetAsset', () => {
  it('负余额 credit/debt 记负债：净资产 = 资产 - 欠款', () => {
    const accounts: AccountRow[] = [
      acc({ name: '工行卡', type: 'fund', balance: 5000 }),
      acc({ name: '花呗', type: 'credit', balance: -1500 }),
      acc({ name: '房贷', type: 'debt', balance: -3000 }),
    ];
    expect(calcNetAsset(accounts)).toBeCloseTo(5000 - 1500 - 3000, 6);
  });

  it('正余额 credit/debt 记资产（多还/退款在途），不是负债', () => {
    const accounts: AccountRow[] = [
      acc({ name: '工行卡', type: 'fund', balance: 1000 }),
      acc({ name: '花呗', type: 'credit', balance: 139.29 }),
    ];
    expect(calcNetAsset(accounts)).toBeCloseTo(1139.29, 6);
  });

  it('正负余额混合：净资产恒等于 Σ 计入账户的余额', () => {
    const accounts: AccountRow[] = [
      acc({ name: '现金', type: 'fund', balance: 12248.71 }),
      acc({ name: '零钱通', type: 'invest', balance: 960.81 }),
      acc({ name: '余额宝', type: 'invest', balance: -411.76 }),
      acc({ name: '工行卡', type: 'fund', balance: -36089.78 }),
      acc({ name: '中行卡', type: 'fund', balance: -2084.36 }),
      acc({ name: '建行卡', type: 'fund', balance: -3000 }),
      acc({ name: '花呗', type: 'credit', balance: 139.29 }),
    ];
    const sum = accounts.reduce((s, a) => s + a.balance, 0);
    expect(sum).toBeCloseTo(-28237.09, 2);
    expect(calcNetAsset(accounts)).toBeCloseTo(sum, 6);
  });

  it('includeInNetAsset=0 的账户被排除', () => {
    const accounts: AccountRow[] = [
      acc({ name: '现金', type: 'fund', balance: 1000 }),
      acc({ name: '隐藏', type: 'fund', balance: 9999, includeInNetAsset: 0 }),
    ];
    expect(calcNetAsset(accounts)).toBe(1000);
  });

  it('空数组：净资产为 0', () => {
    expect(calcNetAsset([])).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// HTTP 口径：netAsset 必须等于 Σ includeInNetAsset 账户余额
// ══════════════════════════════════════════════════════════════

let server: Server;
let baseUrl: string;
let memDb: import('better-sqlite3').Database;

beforeAll(async () => {
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);
  ensureSeed(memDb);

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

describe('GET /api/summary · netAsset', () => {
  it('netAsset 等于 Σ 计入净资产的账户余额（正余额信用账户不再翻转）', async () => {
    // seed 的默认账户先清掉，只留我们构造的形状
    memDb.prepare('DELETE FROM accounts').run();
    memDb.prepare('DELETE FROM transactions').run();

    const rows: Array<[string, string, number]> = [
      ['现金', 'fund', 12248.71],
      ['零钱通', 'invest', 960.81],
      ['余额宝', 'invest', -411.76],
      ['工行卡', 'fund', -36089.78],
      ['中行卡', 'fund', -2084.36],
      ['建行卡', 'fund', -3000],
      ['花呗', 'credit', 139.29], // 多还/退款在途 —— ISSUE-005 的触发点
    ];
    const ins = memDb.prepare(
      'INSERT INTO accounts (name, type, balance, includeInNetAsset, createdAt, updatedAt) VALUES (?, ?, ?, 1, 0, 0)',
    );
    for (const [name, type, balance] of rows) ins.run(name, type, balance);

    const res = await fetch(`${baseUrl}/api/summary`);
    const sum = (await res.json()) as { netAsset: number };
    const total = rows.reduce((s, [, , b]) => s + b, 0);

    expect(total).toBeCloseTo(-28237.09, 2);
    expect(sum.netAsset).toBeCloseTo(total, 2);
    // 旧口径会得到 -28515.67（多扣 2×139.29）
    expect(sum.netAsset).not.toBeCloseTo(-28515.67, 2);
  });
});
