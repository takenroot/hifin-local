/**
 * hifin-core 数据库层集成测试
 * - 用 :memory: 跑全流程：openDatabase → migrate → ensureSeed
 * - 验证 12 张表存在；ensureSeed 幂等不翻倍；默认空间 id=1
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { openDatabase } from '../src/db/connection.js';
import { migrate, getUserVersion } from '../src/db/migrate.js';
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
] as const;

describe('db layer', () => {
  let db = openDatabase(':memory:');

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('migrate creates all 12 expected tables', () => {
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
    expect(getUserVersion(db)).toBe(1);
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