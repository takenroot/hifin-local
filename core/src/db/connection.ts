/**
 * hifin-core 数据库连接层
 * - 默认打开 <core>/data/hifin.db；目录不存在自动 mkdir
 * - 传 ":memory:" 使用内存库（测试用）
 * - 启用 WAL + foreign_keys = ON
 * - 导出 getDb() 单例（懒加载）
 */

import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_DB_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'data',
  'hifin.db',
);

let singleton: DatabaseType | null = null;
let singletonPath: string | null = null;

/** 打开一个 SQLite 数据库实例，应用项目级 PRAGMA 设置。 */
export function openDatabase(path: string = DEFAULT_DB_PATH): DatabaseType {
  const db: DatabaseType =
    path === ':memory:'
      ? new Database(':memory:')
      : (() => {
          const absPath = isAbsolute(path) ? path : resolve(path);
          mkdirSync(dirname(absPath), { recursive: true });
          return new Database(absPath);
        })();

  // 项目级 PRAGMA：WAL + 外键约束
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  return db;
}

/** 获取默认数据库单例（懒初始化）。同一路径复用同一连接。 */
export function getDb(): DatabaseType {
  if (singleton === null) {
    singleton = openDatabase(DEFAULT_DB_PATH);
    singletonPath = DEFAULT_DB_PATH;
  }
  return singleton;
}

/** 重置单例（测试 / 热重载场景）。 */
export function resetDb(): void {
  if (singleton !== null) {
    try {
      singleton.close();
    } catch {
      // ignore close errors during reset
    }
  }
  singleton = null;
  singletonPath = null;
}

/** 当前单例所对应的路径；未初始化则返回 null。 */
export function getDbPath(): string | null {
  return singletonPath;
}

export type { DatabaseType };