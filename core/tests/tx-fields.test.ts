/**
 * 溯源四件套（source / externalId / paymentMethod / status）测试
 * -----------------------------------------------------------------
 * 覆盖四条链路：
 *   1. schema 迁移：补列 + 部分唯一索引，且**重复执行**不翻车
 *   2. 解析：账单里的平台列能不能读出来、组合支付有没有取 & 前段、'/' 有没有被规整
 *   3. 落库 + 去重：有单号走 (source, externalId) 精确判重，没单号退回四字段启发式
 *   4. REST：POST 默认 source='manual'、GET 把四个字段吐出来
 *
 * 去重那组是重点：两条路径**必须**互斥。曾经考虑过"两条都查"，
 * 但那会让"同一天同金额同商户的两笔真实消费"被误杀——而这恰恰是引入
 * 平台单号要解决的问题，所以断言里专门钉死了"有单号时不看四元组"。
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate, getColumns, CURRENT_SCHEMA_VERSION } from '../src/db/migrate.js';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import { importTransactions } from '../src/mail/importer.ts';
import type { ParsedTx } from '../src/mail/parsers/base.ts';
import { parseCsvText } from '../../app/src/features/transactions/csv.ts';

const NEW_COLUMNS = ['source', 'externalId', 'paymentMethod', 'status'] as const;

/** 内存库 + 一个 id=1 的账户，余额起点 0，便于直接看联动结果 */
function makeDb(balance = 0): Database.Database {
  const db = openDatabase(':memory:');
  migrate(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '现金', 'fund', ?, 1, 1, ?, ?)`,
  ).run(balance, now, now);
  return db;
}

function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    date: 1_700_000_000_000,
    amount: 10,
    type: 'expense',
    merchant: '康巴什区乐佳超市',
    ...over,
  };
}

// ══════════════════════════════════════════════════════════════
describe('schema 迁移：四列 + 部分唯一索引', () => {
  it('新建库上四个溯源列都在', () => {
    const db = makeDb();
    const cols = getColumns(db, 'transactions');
    for (const c of NEW_COLUMNS) expect(cols).toContain(c);
    db.close();
  });

  it('migrate 幂等：连跑三次不报错、列不重复、版本稳定', () => {
    const db = makeDb();
    migrate(db);
    migrate(db);
    migrate(db);
    const cols = getColumns(db, 'transactions');
    for (const c of NEW_COLUMNS) {
      expect(cols.filter((x) => x === c)).toHaveLength(1);
    }
    expect(
      (db.pragma('user_version', { simple: true }) as number),
    ).toBe(CURRENT_SCHEMA_VERSION);
    db.close();
  });

  it('老库（无这四列）能被 migrate 补齐，且不改动既有数据', () => {
    const db = new Database(':memory:');
    // 手工造一个 v1 形状的 transactions：没有四个溯源列
    db.exec(`
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('expense','income','transfer','excluded')),
        name TEXT NOT NULL,
        amount REAL NOT NULL CHECK(amount > 0),
        date INTEGER NOT NULL,
        categoryId INTEGER,
        accountId INTEGER NOT NULL,
        toAccountId INTEGER,
        remark TEXT,
        tagIds TEXT,
        merchantId INTEGER,
        includeInAsset INTEGER NOT NULL DEFAULT 1,
        spaceId INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL
      );
    `);
    db.exec(SCHEMA_SQL); // 其余表照常建出来
    db.prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt)
       VALUES ('expense', '老数据', 12.5, 1700000000000, 1, 1, 1, 1)`,
    ).run();

    migrate(db);

    const cols = getColumns(db, 'transactions');
    for (const c of NEW_COLUMNS) expect(cols).toContain(c);
    // 老行的新列必须是 NULL，不能被默认值污染
    const row = db
      .prepare('SELECT name, amount, source, externalId, paymentMethod, status FROM transactions')
      .get() as Record<string, unknown>;
    expect(row.name).toBe('老数据');
    expect(row.amount).toBe(12.5);
    expect(row.source).toBeNull();
    expect(row.externalId).toBeNull();
    expect(row.paymentMethod).toBeNull();
    expect(row.status).toBeNull();
    db.close();
  });

  it('部分唯一索引：同 (source, externalId) 插第二条被拒', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt, source, externalId)
       VALUES ('expense', ?, ?, 1, 1, 1, 1, 1, ?, ?)`,
    );
    ins.run('A', 10, 'wechat', '4500000001');
    expect(() => ins.run('B', 99, 'wechat', '4500000001')).toThrow(/UNIQUE/);
    db.close();
  });

  it('部分唯一索引：externalId 为 NULL 的行互不冲突（手工记账不能被卡住）', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt, source, externalId)
       VALUES ('expense', ?, ?, 1, 1, 1, 1, 1, ?, NULL)`,
    );
    ins.run('A', 10, 'manual');
    expect(() => ins.run('B', 20, 'manual')).not.toThrow();
    const n = (
      db.prepare('SELECT COUNT(*) c FROM transactions WHERE source = ?').get('manual') as { c: number }
    ).c;
    expect(n).toBe(2);
    db.close();
  });

  it('同号不同平台不算重复（两个平台的单号命名空间彼此独立）', () => {
    const db = makeDb();
    const ins = db.prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt, source, externalId)
       VALUES ('expense', ?, 10, 1, 1, 1, 1, 1, ?, ?)`,
    );
    ins.run('A', 'alipay', '2026100129020999060153635382');
    expect(() => ins.run('B', 'wechat', '2026100129020999060153635382')).not.toThrow();
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════
describe('账单解析：平台列 → 四个溯源字段', () => {
  const ALIPAY_CSV = [
    '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注',
    '2026-10-01 12:00:00,餐饮美食,蜜雪冰城,,冰淇淋,支出,6.00,花呗&花呗信用购立减,交易成功,2026100129020999060153635382,,/',
    '2026-10-02 09:00:00,退款,蜜雪冰城,,退款,收入,6.00,账户余额,退款成功,2026100229020999060153635399,,已退款',
  ].join('\n');

  const WECHAT_CSV = [
    '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
    '2026-09-27 12:47:34,商户消费,康巴什区乐佳超市,,支出,10,零钱通,支付成功,4500000472202609272901790231,,/',
    '2026-09-05 10:42:49,转入零钱通-来自工商银行(1230),/,/,/,1000,工商银行储蓄卡(1230),支付成功,4200003148202609057538238477,,/',
  ].join('\n');

  it('支付宝：source / externalId / paymentMethod(取&前段) / status 全部读出', () => {
    const p = parseCsvText(ALIPAY_CSV, 'alipay');
    const first = p.items[0];
    expect(first.source).toBe('alipay');
    expect(first.externalId).toBe('2026100129020999060153635382');
    // 组合支付只留主渠道
    expect(first.paymentMethod).toBe('花呗');
    expect(first.status).toBe('交易成功');
  });

  it('微信：四列同样读出，支付方式原样保留', () => {
    const p = parseCsvText(WECHAT_CSV, 'wechat');
    const first = p.items[0];
    expect(first.source).toBe('wechat');
    expect(first.externalId).toBe('4500000472202609272901790231');
    expect(first.paymentMethod).toBe('零钱通');
    expect(first.status).toBe('支付成功');
  });

  it('备注是占位符 "/" 时规整成 undefined（不落库就是 NULL）', () => {
    const a = parseCsvText(ALIPAY_CSV, 'alipay');
    expect(a.items[0].remark).toBeUndefined();
    expect(a.items[1].remark).toBe('已退款'); // 真备注要留住
    const w = parseCsvText(WECHAT_CSV, 'wechat');
    expect(w.items[0].remark).toBeUndefined();
  });

  it('零钱通划转行收/支为 "/" → 判为 excluded，不会被当成收支导入', () => {
    const w = parseCsvText(WECHAT_CSV, 'wechat');
    const transfer = w.items.find((i) => i.externalId === '4200003148202609057538238477');
    expect(transfer).toBeDefined();
    expect(transfer!.type).toBe('excluded');
    expect(transfer!.billCategory).toBe('转入零钱通-来自工商银行(1230)');
  });

  it('非支付宝/微信账单归 source=csv', () => {
    const generic = ['日期,金额,收/支,对方,备注', '2026-10-01 12:00:00,50,支出,某商户,测试'].join('\n');
    const p = parseCsvText(generic, 'generic');
    expect(p.items[0].source).toBe('csv');
    expect(p.items[0].externalId).toBeUndefined(); // 没有单号列就不编一个
  });
});

// ══════════════════════════════════════════════════════════════
describe('importTransactions：字段落库', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb(0);
  });
  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('四个字段原样落库，并联动余额', () => {
    const res = importTransactions(db, [tx({ source: 'wechat', externalId: '4500-A', paymentMethod: '零钱通', status: '支付成功' })], 1);
    expect(res.imported).toBe(1);
    const row = db
      .prepare('SELECT source, externalId, paymentMethod, status, remark FROM transactions')
      .get() as Record<string, unknown>;
    expect(row.source).toBe('wechat');
    expect(row.externalId).toBe('4500-A');
    expect(row.paymentMethod).toBe('零钱通');
    expect(row.status).toBe('支付成功');
    expect(row.remark).toBeNull();
    expect((db.prepare('SELECT balance FROM accounts WHERE id=1').get() as { balance: number }).balance).toBe(-10);
  });

  it("空串与 '/' 都规整成 NULL（不留占位符）", () => {
    importTransactions(
      db,
      [tx({ source: 'csv', externalId: '', paymentMethod: '/', status: '  ', remark: '/' })],
      1,
    );
    const row = db
      .prepare('SELECT source, externalId, paymentMethod, status, remark FROM transactions')
      .get() as Record<string, unknown>;
    expect(row.externalId).toBeNull();
    expect(row.paymentMethod).toBeNull();
    expect(row.status).toBeNull();
    expect(row.remark).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
describe('去重：两条路径互斥', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb(0);
  });
  afterAll(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('路径 A（有 externalId）：同 (source, externalId) 即使四元组不同也算重复', () => {
    importTransactions(db, [tx({ source: 'wechat', externalId: '4500-SAME', amount: 10 })], 1);
    const res = importTransactions(
      db,
      // 金额、时间、商户全不同，只靠单号认出来是同一笔
      [tx({ source: 'wechat', externalId: '4500-SAME', amount: 88, date: 1_800_000_000_000, merchant: '别家' })],
      1,
    );
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c).toBe(1);
  });

  it('路径 A（有 externalId）：四元组相同但单号不同 → **不算**重复，两笔都进', () => {
    // 这是引入单号的意义所在：同一天同金额同商户的两笔真实消费必须都留住
    importTransactions(db, [tx({ source: 'wechat', externalId: '4500-1' })], 1);
    const res = importTransactions(db, [tx({ source: 'wechat', externalId: '4500-2' })], 1);
    expect(res.imported).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c).toBe(2);
  });

  it('路径 A：同号但 source 不同不算重复', () => {
    importTransactions(db, [tx({ source: 'wechat', externalId: 'SAME-ID' })], 1);
    const res = importTransactions(db, [tx({ source: 'alipay', externalId: 'SAME-ID' })], 1);
    expect(res.imported).toBe(1);
  });

  it('路径 A：同一批次内重复的单号也会被挡住（不会撞唯一索引）', () => {
    const res = importTransactions(
      db,
      [
        tx({ source: 'wechat', externalId: '4500-DUP', amount: 10 }),
        tx({ source: 'wechat', externalId: '4500-DUP', amount: 20 }),
      ],
      1,
    );
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('路径 B（无 externalId）：退回四字段启发式', () => {
    importTransactions(db, [tx({ source: 'manual' })], 1);
    const res = importTransactions(db, [tx({ source: 'manual' })], 1);
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
  });

  it('路径 B：无 externalId 但四元组不同 → 正常入库', () => {
    importTransactions(db, [tx({ source: 'manual', amount: 10 })], 1);
    const res = importTransactions(db, [tx({ source: 'manual', amount: 11 })], 1);
    expect(res.imported).toBe(1);
  });

  it('dedupe:false 时不做判重，但唯一索引仍把重复挡在门外（跳过而非整批失败）', () => {
    importTransactions(db, [tx({ source: 'wechat', externalId: 'X' })], 1, { dedupe: false });
    const res = importTransactions(db, [tx({ source: 'wechat', externalId: 'X' })], 1, { dedupe: false });
    // 判重关掉了，但 DB 层的部分唯一索引是最后一道防线：
    // 这一笔被 UNIQUE 拒绝并计入 skipped，而不是抛异常把整批导入带崩
    expect(res.imported).toBe(0);
    expect(res.skipped).toBe(1);
    expect((db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c).toBe(1);
  });

  it('重复单号被跳过后，同批次的其它行照常入库', () => {
    const res = importTransactions(
      db,
      [
        tx({ source: 'wechat', externalId: 'DUP', amount: 10 }),
        tx({ source: 'wechat', externalId: 'DUP', amount: 20 }),
        tx({ source: 'wechat', externalId: 'OK', amount: 30 }),
      ],
      1,
      { dedupe: false },
    );
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
describe('REST /api/transactions', () => {
  let app: import('express').Express;
  let server: Server;
  let baseUrl: string;
  let memDb: import('better-sqlite3').Database;
  let accountId: number;

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

  beforeEach(async () => {
    // 每个用例一套全新的 app + 内存库，互不干扰
    memDb = openDatabase(':memory:');
    const { setActiveDb } = await import('../src/routes/_db.js');
    setActiveDb(memDb);
    migrate(memDb);
    const { createApp } = await import('../src/server.js');
    app = createApp({ skipBootstrap: true });
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const acc = await http('/api/accounts', {
      method: 'POST',
      body: { name: 'REST溯源账户', type: 'fund', balance: 0, spaceId: 900 },
    });
    accountId = (acc.data as { id: number }).id;
  });

  afterAll(() => {
    try {
      memDb?.close();
    } catch {
      /* ignore */
    }
  });

  it('POST 不带 source 时默认写 manual', async () => {
    const res = await http('/api/transactions', {
      method: 'POST',
      body: { type: 'expense', name: '手工记一笔', amount: 20, accountId, spaceId: 900 },
    });
    expect(res.status).toBe(201);
    expect((res.data as { source: string }).source).toBe('manual');
  });

  it('POST 显式带 source 时按传入的写', async () => {
    const res = await http('/api/transactions', {
      method: 'POST',
      body: { type: 'expense', name: 'CSV 导入', amount: 20, accountId, spaceId: 900, source: 'csv' },
    });
    expect(res.status).toBe(201);
    expect((res.data as { source: string }).source).toBe('csv');
  });

  it('POST 传空串 source 视为没传，回落 manual', async () => {
    const res = await http('/api/transactions', {
      method: 'POST',
      body: { type: 'expense', name: '空串', amount: 20, accountId, spaceId: 900, source: '   ' },
    });
    expect((res.data as { source: string }).source).toBe('manual');
  });

  it('GET 把四个溯源字段一起吐出来', async () => {
    const now = Date.now();
    memDb
      .prepare(
        `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt, source, externalId, paymentMethod, status)
         VALUES ('expense','账单行', 33, ?, ?, 1, 900, ?, 'wechat', '4500-GET', '零钱通', '支付成功')`,
      )
      .run(now, accountId, now);

    const res = await http('/api/transactions?spaceId=900');
    expect(res.status).toBe(200);
    const rows = res.data as Array<Record<string, unknown>>;
    const row = rows.find((r) => r.name === '账单行');
    expect(row).toBeDefined();
    expect(row!.source).toBe('wechat');
    expect(row!.externalId).toBe('4500-GET');
    expect(row!.paymentMethod).toBe('零钱通');
    expect(row!.status).toBe('支付成功');
  });
});
