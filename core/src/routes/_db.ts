/**
 * 路由层本地 db 单例（解决 src/db/connection.ts 的 openDatabase/getDb 契约缺口）。
 *
 * 原因：另一 agent 提供的 connection.ts 中 openDatabase(path) 不会写入 getDb() 的单例，
 * 而 getDb() 只初始化到默认文件路径。当需要在 :memory: 或其它路径下测试时，
 * 路由层无法直接拿到目标 db。
 *
 * 本模块为 routes 单独维护一个 activeDb：
 *   - 路由直接调用 getDb() 取 db
 *   - server.ts 在 createApp({ dbPath }) 时调用 setActiveDb(openDatabase(dbPath))
 *   - 这样无需修改另一 agent 的 connection.ts
 */
import type Database from 'better-sqlite3';
import { openDatabase } from '../db/connection.js';

let activeDb: Database.Database | null = null;

export function setActiveDb(db: Database.Database): void {
  activeDb = db;
}

export function getDb(): Database.Database {
  if (activeDb === null) {
    // 默认走 connection.ts 的 openDatabase(DEFAULT_DB_PATH)，但不用其单例
    activeDb = openDatabase();
  }
  return activeDb;
}
