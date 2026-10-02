/**
 * hifin-core 数据库迁移层
 * -----------------------------------------------------------------
 * 两层机制，缺一不可：
 *   1. 幂等执行 SCHEMA_SQL（所有 CREATE 都用 IF NOT EXISTS）
 *      —— 只能管"新建"，CREATE TABLE IF NOT EXISTS 对已存在的表是**完全空转**的，
 *         所以它管不到"给老表加列"。
 *   2. 显式的列级迁移（ensureColumns）—— 按 PRAGMA table_info 查缺哪列补哪列，
 *      再补上依赖新列的索引。
 *
 * 顺序是硬要求：SCHEMA_SQL → 补列 → 建索引。索引引用 source/externalId，
 * 老库上这两列在补列之前还不存在，先建索引会直接 no such column 报错。
 *
 * 版本号只做"记账"，不驱动分支：每一步迁移都自己判断要不要做，
 * 所以重复执行、跨版本直接跳到最新，都不会出错或重复加列。
 */

import type { DatabaseType } from './connection.js';
import { SCHEMA_SQL } from './schema.js';

const SCHEMA_VERSION = 2;

/**
 * 列级迁移：table + 需要补上的列 + 该列的 DDL 片段。
 *
 * 全部 nullable 且无默认值，所以补列对老数据是安全的（读出来是 NULL），
 * 也不需要回填——真正的赋值由 scripts/backfill-fields.ts 从账单原件重解析后写入。
 */
const COLUMN_MIGRATIONS: ReadonlyArray<{
  table: string;
  column: string;
  ddl: string;
}> = [
  { table: 'transactions', column: 'source', ddl: 'TEXT' },
  { table: 'transactions', column: 'externalId', ddl: 'TEXT' },
  { table: 'transactions', column: 'paymentMethod', ddl: 'TEXT' },
  { table: 'transactions', column: 'status', ddl: 'TEXT' },
];

/**
 * (source, externalId) 部分唯一索引。
 *
 * WHERE externalId IS NOT NULL 是关键：手工记账和库里的老数据没有平台单号，
 * 若不加这个条件，所有 source 为 NULL / externalId 为 NULL 的行会被当成
 * 同一个 key 互撞，导致第二笔手工记账就插不进去。
 *
 * 用 (source, externalId) 组合而不是单列 externalId：不同平台的单号命名空间
 * 彼此独立（微信 45…、支付宝 2026…），混在一列里没有"跨平台撞号"的风险，
 * 却会让同一笔交易换平台记账时被误判成重复。
 */
export const TX_EXTERNAL_ID_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_tx_source_external
  ON transactions(source, externalId)
  WHERE externalId IS NOT NULL
`;

/** 读某张表已有的列名（小写返回，与 SQLite 内部一致）。 */
export function getColumns(db: DatabaseType, table: string): string[] {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

/** 补齐 COLUMNS_MIGRATIONS 里缺失的列；返回实际执行过的 ALTER TABLE 语句。 */
export function ensureColumns(db: DatabaseType): string[] {
  const applied: string[] = [];
  const seen = new Map<string, Set<string>>();
  for (const m of COLUMN_MIGRATIONS) {
    let cols = seen.get(m.table);
    if (!cols) {
      cols = new Set(getColumns(db, m.table));
      seen.set(m.table, cols);
    }
    if (cols.has(m.column)) continue;
    const sql = `ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.ddl}`;
    db.exec(sql);
    cols.add(m.column);
    applied.push(sql);
  }
  return applied;
}

/** 在空库或老库上应用最新 schema；可重复调用。 */
export function migrate(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);
  // 补列必须先于建索引（见文件头注释）
  ensureColumns(db);
  db.exec(TX_EXTERNAL_ID_INDEX_SQL);
  if (getUserVersion(db) !== SCHEMA_VERSION) {
    setUserVersion(db, SCHEMA_VERSION);
  }
}

/** 读取 PRAGMA user_version。 */
export function getUserVersion(db: DatabaseType): number {
  const row = db.pragma('user_version', { simple: true }) as unknown;
  if (typeof row === 'number') return row;
  const n = Number(row);
  return Number.isFinite(n) ? n : 0;
}

/** 写入 PRAGMA user_version。 */
export function setUserVersion(db: DatabaseType, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`invalid schema version: ${version}`);
  }
  db.pragma(`user_version = ${version}`);
}

export { SCHEMA_VERSION as CURRENT_SCHEMA_VERSION };
