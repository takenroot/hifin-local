/**
 * hifin-core 数据库层集成测试
 * - 用 :memory: 跑全流程：openDatabase → migrate → ensureSeed
 * - 验证 14 张表存在；ensureSeed 幂等不翻倍；默认空间 id=1
 * - v2 老库升级：notifications 的 CHECK 约束只能靠重建表放开
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import {
  migrate,
  getUserVersion,
  CURRENT_SCHEMA_VERSION,
  ensureNotificationsShape,
} from '../src/db/migrate.js';
import { ensureSeed, DEFAULT_SPACE_ID } from '../src/db/seed.js';

const EXPECTED_TABLES = [
  'spaces',
  'accounts',
  'transactions',
  'goals',
  'categories',
  'tags',
  'merchants',
  'reports',
  'aiModels',
  'budgets',
  'rules',
  'kv',
  'notifications',
  'accountYields',
] as const;

describe('db layer', () => {
  let db = openDatabase(':memory:');

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('migrate creates all 14 expected tables', () => {
    migrate(db);
    const rows = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = rows.map((r) => r.name);
    expect(names).toEqual([...EXPECTED_TABLES].sort());
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });

  it('migrate is idempotent (re-run keeps user_version & tables)', () => {
    migrate(db);
    migrate(db);
    // 对齐 CURRENT_SCHEMA_VERSION 而不是写死数字：以后再迁一次版本，
    // 这条断言不该跟着改，它要证明的是"重复跑不会把版本改乱"。
    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    const count = (db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .get() as { c: number }).c;
    expect(count).toBe(EXPECTED_TABLES.length);
  });

  it('ensureSeed inserts default space id=1 with name "默认空间"', () => {
    migrate(db);
    ensureSeed(db);
    const row = db
      .prepare('SELECT id, name FROM spaces WHERE id = ?')
      .get(DEFAULT_SPACE_ID) as { id: number; name: string };
    expect(row).toBeDefined();
    expect(row.id).toBe(1);
    expect(row.name).toBe('默认空间');
  });

  it('ensureSeed inserts exactly 33 categories and 4 tags', () => {
    migrate(db);
    ensureSeed(db);
    const catCount = (db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
    const tagCount = (db.prepare('SELECT COUNT(*) AS c FROM tags').get() as { c: number }).c;
    expect(catCount).toBe(33);
    expect(tagCount).toBe(4);
  });

  it('ensureSeed is idempotent (running twice does not double the counts)', () => {
    migrate(db);
    ensureSeed(db);
    ensureSeed(db);
    const catCount = (db.prepare('SELECT COUNT(*) AS c FROM categories').get() as { c: number }).c;
    const tagCount = (db.prepare('SELECT COUNT(*) AS c FROM tags').get() as { c: number }).c;
    const spaceCount = (db.prepare('SELECT COUNT(*) AS c FROM spaces').get() as { c: number }).c;
    expect(catCount).toBe(33);
    expect(tagCount).toBe(4);
    expect(spaceCount).toBe(1);
  });
});

/**
 * accountYields 表本身的约束（v3 新表）。
 * UNIQUE(accountId, year) 是幂等写入与"是否已填"判定的地基，必须单独验一遍。
 */
describe('db: accountYields 表', () => {
  let db = openDatabase(':memory:');

  beforeEach(() => {
    db = openDatabase(':memory:');
    migrate(db);
    db.prepare(
      `INSERT INTO accounts (name, type, balance, includeInNetAsset, createdAt, updatedAt)
       VALUES ('零钱通', 'invest', 100, 1, 1, 1)`,
    ).run();
  });

  it('列结构与契约一致，且 (accountId, year) 唯一', () => {
    const cols = (db.pragma('table_info(accountYields)') as Array<{
      name: string; type: string; notnull: number;
    }>).map((c) => ({ name: c.name, type: c.type, notnull: c.notnull }));

    expect(cols).toEqual([
      { name: 'id', type: 'INTEGER', notnull: 0 },
      { name: 'accountId', type: 'INTEGER', notnull: 1 },
      { name: 'year', type: 'INTEGER', notnull: 1 },
      { name: 'yieldPercent', type: 'REAL', notnull: 1 },
      { name: 'note', type: 'TEXT', notnull: 0 },
      { name: 'createdAt', type: 'INTEGER', notnull: 1 },
    ]);

    const accId = (db.prepare("SELECT id FROM accounts WHERE name = '零钱通'").get() as { id: number }).id;
    db.prepare(
      'INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt) VALUES (?, ?, ?, ?, ?)',
    ).run(accId, 2025, 1.83, '年末看了一眼', 1000);

    // 同账户同年再插必须被 UNIQUE 挡住
    expect(() =>
      db
        .prepare(
          'INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt) VALUES (?, ?, ?, ?, ?)',
        )
        .run(accId, 2025, 9.99, null, 2000),
    ).toThrow(/UNIQUE/);

    // 别的年份可以并存
    db.prepare(
      'INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt) VALUES (?, ?, ?, ?, ?)',
    ).run(accId, 2024, 2.1, null, 2000);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM accountYields').get() as { c: number }).c,
    ).toBe(2);
  });

  it('ON CONFLICT upsert 不会新建行，只改数字与备注', () => {
    const accId = (db.prepare('SELECT id FROM accounts WHERE name = ' + "'零钱通'").get() as { id: number }).id;
    db.prepare(
      'INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt) VALUES (?, ?, ?, ?, ?)',
    ).run(accId, 2025, 1.83, '第一版', 1000);
    db.prepare(
      `INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(accountId, year) DO UPDATE SET
         yieldPercent = excluded.yieldPercent, note = excluded.note`,
    ).run(accId, 2025, 1.95, '第二版', 2000);

    const rows = db
      .prepare('SELECT year, yieldPercent, note, createdAt FROM accountYields ORDER BY year')
      .all() as Array<{ year: number; yieldPercent: number; note: string; createdAt: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].yieldPercent).toBeCloseTo(1.95, 6);
    expect(rows[0].note).toBe('第二版');
    // createdAt 记录"这条记录第一次被创建"的时间，upsert 不动它
    expect(rows[0].createdAt).toBe(1000);
  });
});

/**
 * v2 → v3 的真实升级路径。
 *
 * 关键在于 :memory: 空库永远走不到这段：SCHEMA_SQL 会直接建出**新形状**的表，
 * ensureNotificationsShape 立刻返回 false。只有手工造一张 v2 老表（老 CHECK）
 * 才能证明"重建表"这条路真的能走通且不丢数据。
 */
describe('db: v2 → v3 迁移（老 notifications 表重建）', () => {
  /** 造一张 v2 形状的库：老 CHECK 约束、无 payload 列、user_version=2 */
  function makeV2Db(): ReturnType<typeof openDatabase> {
    const legacy = openDatabase(':memory:');
    legacy.exec(`
      CREATE TABLE notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL CHECK(type IN ('need_password','password_error','import_success','import_failed')),
        title TEXT NOT NULL,
        message TEXT,
        bill_uid INTEGER,
        platform TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed','failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);
      CREATE TABLE accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK(type IN ('fund','asset','social','invest','other','credit','debt')),
        balance REAL NOT NULL DEFAULT 0,
        remark TEXT,
        tagIds TEXT,
        includeInNetAsset INTEGER NOT NULL DEFAULT 1,
        spaceId INTEGER DEFAULT 1,
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      );
    `);
    legacy.exec(
      `INSERT INTO notifications (type, title, message, bill_uid, platform, status, retry_count, createdAt, updatedAt)
       VALUES ('need_password', '待输入密码', '账单 20240512', 1811, 'alipay', 'pending', 2, 1000, 1000),
              ('import_success', '导入成功', '已导入 128 笔', NULL, 'wechat', 'resolved', 0, 2000, 2000),
              ('import_failed', '导入失败', '密码错误过多', 1812, 'alipay', 'failed', 3, 3000, 3000)`,
    );
    legacy.exec(
      "INSERT INTO accounts (name, type, balance, createdAt, updatedAt) VALUES ('零钱通', 'invest', 960.81, 1, 1)",
    );
    legacy.pragma('user_version = 2');
    return legacy;
  }

  function dumpNotifications(db: ReturnType<typeof openDatabase>): unknown[] {
    return db
      .prepare(
        'SELECT id, type, title, message, bill_uid, platform, status, retry_count, createdAt, updatedAt FROM notifications ORDER BY id',
      )
      .all();
  }

  it('老表被重建：数据逐行不变，新 type/status 可以写入', () => {
    const db = makeV2Db();
    const before = dumpNotifications(db);

    // 迁移前：新 type 在老 CHECK 下必然被拒
    expect(() =>
      db
        .prepare(
          `INSERT INTO notifications (type, title, status, createdAt, updatedAt) VALUES ('yield-reminder', '催填', 'pending', 1, 1)`,
        )
        .run(),
    ).toThrow(/CHECK/i);

    migrate(db);

    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    // 逐行比对：重建过程中一列都不能丢
    expect(dumpNotifications(db)).toEqual(before);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM accounts').get() as { c: number }).c,
    ).toBe(1);

    // 新 type + 新 status 现在合法了
    db.prepare(
      `INSERT INTO notifications (type, title, status, createdAt, updatedAt, payload)
       VALUES ('yield-reminder', '催填 2025', 'pending', 1, 1, '{"accountId":1,"year":2025}')`,
    ).run();
    db.prepare(
      `INSERT INTO notifications (type, title, status, createdAt, updatedAt)
       VALUES ('yield-reminder', '催填过期', 'expired', 1, 1)`,
    ).run();
    const fresh = db
      .prepare("SELECT status, payload FROM notifications WHERE title IN ('催填 2025','催填过期') ORDER BY id")
      .all() as Array<{ status: string; payload: string | null }>;
    expect(fresh[0].status).toBe('pending');
    expect(fresh[0].payload).toBe('{"accountId":1,"year":2025}');
    expect(fresh[1].status).toBe('expired');

    db.close();
  });

  it('accountYields 表在老库上被补建', () => {
    const db = makeV2Db();
    expect(
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='accountYields'").get() as { c: number }).c,
    ).toBe(0);
    migrate(db);
    expect(
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='accountYields'").get() as { c: number }).c,
    ).toBe(1);
    db.close();
  });

  it('迁移幂等：连跑三遍，通知不多不少、user_version 不变', () => {
    const db = makeV2Db();
    migrate(db);
    migrate(db);
    migrate(db);

    expect(getUserVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect((db.prepare('SELECT COUNT(*) AS c FROM notifications').get() as { c: number }).c).toBe(3);
    // 临时表不能残留
    expect(
      (db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name='notifications_legacy_v2'").get() as { c: number }).c,
    ).toBe(0);
    // 索引必须真的挂在新表上（重建时被 DROP 过一次，要补回来）
    const idx = db
      .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_notif_status'")
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toContain('ON notifications(status)');
    db.close();
  });

  it('ensureNotificationsShape 对已是新形状的库是 no-op', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const before = dumpNotifications(db);
    expect(ensureNotificationsShape(db)).toBe(false);
    expect(dumpNotifications(db)).toEqual(before);
    db.close();
  });
});