/**
 * hifin-core 数据库迁移层
 * - 幂等执行 SCHEMA_SQL（所有 CREATE 都用 IF NOT EXISTS）
 * - 通过 PRAGMA user_version 追踪 schema 版本（目前固定为 1）
 */

import type { DatabaseType } from './connection.js';
import { SCHEMA_SQL } from './schema.js';

const SCHEMA_VERSION = 1;

/** 在空库或老库上应用最新 schema；可重复调用。 */
export function migrate(db: DatabaseType): void {
  db.exec(SCHEMA_SQL);
  // 同步 user_version：migrate 不引入破坏性变更时保持 1
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