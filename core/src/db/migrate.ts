/**
 * hifin-core 数据库迁移层
 * -----------------------------------------------------------------
 * 三层机制，缺一不可：
 *   1. 幂等执行 SCHEMA_SQL（所有 CREATE 都用 IF NOT EXISTS）
 *      —— 只能管"新建"，CREATE TABLE IF NOT EXISTS 对已存在的表是**完全空转**的，
 *         所以它管不到"给老表加列"，也管不到"改老表上已经写死的 CHECK 约束"。
 *   2. 显式的列级迁移（ensureColumns）—— 按 PRAGMA table_info 查缺哪列补哪列，
 *      再补上依赖新列的索引。
 *   3. 显式的表重建（ensureNotificationsShape / ensureAccountYieldsShape）
 *      —— CHECK 约束和"改列名"都是**建表时写死**的，SQLite 没有
 *         ALTER TABLE ... DROP CONSTRAINT / RENAME COLUMN，老库要改只能
 *         "建新表 → 拷数据 → 删旧表 → 改名"。
 *
 * 顺序是硬要求：SCHEMA_SQL → 重建 → 补列 → 建索引。
 *  - 重建必须先于补列：payload 是新列，重建时按"老表的 10 列"拷贝更稳，
 *    payload 留给随后的 ensureColumns 去 ALTER。
 *  - 索引引用 source/externalId，老库上这两列在补列之前还不存在，
 *    先建索引会直接 no such column 报错。
 *
 * 版本号只做"记账"，不驱动分支：每一步迁移都自己判断要不要做，
 * 所以重复执行、跨版本直接跳到最新，都不会出错或重复加列/重建。
 */

import type { DatabaseType } from './connection.js';
import { SCHEMA_SQL } from './schema.js';

const SCHEMA_VERSION = 5;

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
  { table: 'notifications', column: 'payload', ddl: 'TEXT' },
];

/** 老版 notifications 的列顺序（v2 建表语句里的 10 列），重建时按这个清单拷贝。 */
const NOTIFICATIONS_V2_COLUMNS = [
  'id',
  'type',
  'title',
  'message',
  'bill_uid',
  'platform',
  'status',
  'retry_count',
  'createdAt',
  'updatedAt',
] as const;

/** 重建期间的临时表名。选一个正常流程里不可能出现的名字，避免撞车。 */
const NOTIFICATIONS_LEGACY_TABLE = 'notifications_legacy_v2';

/** v5 重建期间的临时表名。 */
const NOTIFICATIONS_LEGACY_TABLE_V5 = 'notifications_legacy_v4';

/** 新版 notifications 的建表语句（与 schema.ts 的 SCHEMA_SQL 保持一致）。 */
export const NOTIFICATIONS_V3_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('need_password','password_error','import_success','import_failed','yield-reminder')),
  title TEXT NOT NULL,
  message TEXT,
  bill_uid INTEGER,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed','failed','expired')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  payload TEXT
);
`;

/**
 * v5 notifications 的建表语句：type CHECK 再扩入 'ai-insight'（自动财务洞察）。
 *
 * 同样走"建新表 → 拷数据 → 删旧表 → 改名"的 SQLite 唯一可行路径，
 * 因为 CHECK 约束在建表时固化、SQLite 没有 ALTER DROP CONSTRAINT。
 */
export const NOTIFICATIONS_V5_SQL = `
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('need_password','password_error','import_success','import_failed','yield-reminder','ai-insight')),
  title TEXT NOT NULL,
  message TEXT,
  bill_uid INTEGER,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed','failed','expired')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  payload TEXT
);
`;

/** 读某张表的建表语句；表不存在返回 null。 */
function getTableSql(db: DatabaseType, table: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string | null } | undefined;
  return row?.sql ?? null;
}

/**
 * 把 notifications 表升级到 v3 形状：type 放开 'yield-reminder'、
 * status 放开 'expired'，并（交给 ensureColumns）补 payload 列。
 *
 * 为什么必须重建表：SQLite 的 CHECK 约束在建表时固化，
 * 没有任何 ALTER 语句能改它。老库上的 notifications 只有 4 个 type /
 * 4 个 status 合法，塞进 'yield-reminder' 会直接 CHECK 失败。
 *
 * 幂等性来自**读 sqlite_master 里的建表语句**而不是 user_version：
 * 语句里已经有 'yield-reminder' 且有 payload 列就什么都不做。
 * 这样即使中途失败留下了半成品（user_version 还没跟上），
 * 下次启动也会重新走一遍重建。
 */
export function ensureNotificationsShape(db: DatabaseType): boolean {
  const current = getTableSql(db, 'notifications');
  if (current === null) {
    // SCHEMA_SQL 刚建出来的表就是新形状，无需重建
    return false;
  }
  if (current.includes("'yield-reminder'") && current.includes("'expired'")) {
    return false;
  }

  // 拷贝列按"老表实际有的"取交集：万一将来老库上还多出别的列，
  // 直接按固定 10 列 INSERT 也不会因为某列不存在而炸。
  const existing = new Set(getColumns(db, 'notifications'));
  const copyCols = NOTIFICATIONS_V2_COLUMNS.filter((c) => existing.has(c));

  const run = db.transaction(() => {
    // 索引名会跟着被 RENAME 的表走，必须先显式删掉，
    // 否则后面 CREATE INDEX IF NOT EXISTS 会因"名字已存在"而空转，
    // 新表反而拿不到 idx_notif_status。
    db.exec('DROP INDEX IF EXISTS idx_notif_status;');
    db.exec(`ALTER TABLE notifications RENAME TO ${NOTIFICATIONS_LEGACY_TABLE};`);
    db.exec(NOTIFICATIONS_V3_SQL);
    if (copyCols.length > 0) {
      const cols = copyCols.join(', ');
      db.exec(
        `INSERT INTO notifications (${cols}) SELECT ${cols} FROM ${NOTIFICATIONS_LEGACY_TABLE};`,
      );
    }
    db.exec(`DROP TABLE ${NOTIFICATIONS_LEGACY_TABLE};`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);');
  });
  run();
  return true;
}

/**
 * 把 notifications 表升级到 v5 形状：type 扩入 'ai-insight'。
 *
 * 与 ensureNotificationsShape 同一套思路：
 *  - 读 sqlite_master 的建表语句判断要不要重建（CHECK 里已有 'ai-insight' 就跳过）；
 *  - 重建走"重命名 → 建新表 → INSERT SELECT → DROP"四步；
 *  - 拷贝列按"老表实际有的"取交集（11 列 = 老列 + payload），缺列就跳过；
 *  - 索引 DROP 重建，确保 idx_notif_status 仍挂在新表上。
 */
export function ensureAiInsightNotificationsShape(db: DatabaseType): boolean {
  const current = getTableSql(db, 'notifications');
  if (current === null) {
    // SCHEMA_SQL 刚建出来的就是 v5，无需重建
    return false;
  }
  if (current.includes("'ai-insight'")) {
    return false;
  }

  const existing = new Set(getColumns(db, 'notifications'));
  // v4 的 notifications 有 11 列（含 v3 补的 payload）
  const copyCols = [
    'id',
    'type',
    'title',
    'message',
    'bill_uid',
    'platform',
    'status',
    'retry_count',
    'createdAt',
    'updatedAt',
    'payload',
  ].filter((c) => existing.has(c));

  const run = db.transaction(() => {
    db.exec('DROP INDEX IF EXISTS idx_notif_status;');
    db.exec(`ALTER TABLE notifications RENAME TO ${NOTIFICATIONS_LEGACY_TABLE_V5};`);
    db.exec(NOTIFICATIONS_V5_SQL);
    if (copyCols.length > 0) {
      const cols = copyCols.join(', ');
      db.exec(
        `INSERT INTO notifications (${cols}) SELECT ${cols} FROM ${NOTIFICATIONS_LEGACY_TABLE_V5};`,
      );
    }
    db.exec(`DROP TABLE ${NOTIFICATIONS_LEGACY_TABLE_V5};`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);');
  });
  run();
  return true;
}

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

/**
 * v4 新版 accountYields 的建表语句（与 schema.ts 的 SCHEMA_SQL 保持一致）。
 *
 * 语义在 v4 变过一次：yieldPercent（年收益率 %）→ annualIncome（年度收益金额 元）。
 * SQLite 同样没有 ALTER TABLE ... RENAME COLUMN（列改名），老库只能整表重建。
 */
export const ACCOUNT_YIELDS_V4_SQL = `
CREATE TABLE IF NOT EXISTS accountYields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId INTEGER NOT NULL,
  year INTEGER NOT NULL,
  annualIncome REAL NOT NULL,
  note TEXT,
  createdAt INTEGER NOT NULL,
  UNIQUE(accountId, year)
)
`;

/**
 * v4 表的每一列 ← 老表里对应的来源列。
 *
 * 只有 annualIncome 的来源与列名不同（老列 yieldPercent → 新列 annualIncome），
 * 其余一一对应。这个映射表同时决定了 INSERT 的列序与 SELECT 的投影，
 * 少写一列就会撞 NOT NULL，多写一列就会撞 no such column。
 */
const ACCOUNT_YIELDS_V4_SOURCES: ReadonlyArray<{ col: string; from: string }> = [
  { col: 'id', from: 'id' },
  { col: 'accountId', from: 'accountId' },
  { col: 'year', from: 'year' },
  { col: 'annualIncome', from: 'yieldPercent' },
  { col: 'note', from: 'note' },
  { col: 'createdAt', from: 'createdAt' },
];

/** 重建期间的临时表名。选一个正常流程里不可能出现的名字，避免撞车。 */
const ACCOUNT_YIELDS_LEGACY_TABLE = 'accountYields_legacy_v3';

/** accountYields 上的年份索引（SCHEMA_SQL 里建过，重建后要补回同名索引） */
const YIELD_YEAR_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS idx_yield_year ON accountYields(year);';

/**
 * 把 accountYields 从 v3（yieldPercent）重建成 v4（annualIncome）。
 *
 * 为什么要重建而不是改名：列改名属于 SQLite 不支持的 ALTER 家族，
 * 和 notifications 的 CHECK 约束一样，只能"建新表 → 拷数据 → 删旧表 → 改名"。
 *
 * 幂等性同样来自**读 sqlite_master 的建表语句**，不看 user_version：
 * 已经有 annualIncome 列就直接返回。因此重复执行、中途崩溃留下半成品、
 * 直接从 v2 跳到最新，都不会重复重建。
 *
 * 金额怎么迁：v3 存的是百分比（1.8 = 1.8%），v4 存的是金额，两者没有可换算的
 * 关系（余额已经变了，推不出当年的实际收益）。所以这里**原值拷贝**，
 * 让用户看到自己填过的数并自行改成金额，而不是替他猜一个可能差三个数量级的值。
 */
export function ensureAccountYieldsShape(db: DatabaseType): boolean {
  const existing = getColumns(db, 'accountYields');
  if (existing.length === 0) {
    // 表不存在（SCHEMA_SQL 刚建出来的就是新形状，无需重建）
    return false;
  }
  if (existing.includes('annualIncome') && !existing.includes('yieldPercent')) {
    return false;
  }

  /*
   * 来源列逐个按"老表实际有的"取，与 notifications 迁移同一套容错思路：
   *   - 优先用同名列（万一将来老库上已经有 annualIncome，自愈时不会被覆盖回去）
   *   - 其次用映射表里的来源列（yieldPercent → annualIncome）
   *   - 两边都没有就退化成常量 0：目标列可能是 NOT NULL，缺列不能直接不写
   * 列名全部来自上面的模块级常量表，不含任何外部输入。
   */
  const cols = new Set(existing);
  const targets: string[] = [];
  const sources: string[] = [];
  for (const { col, from } of ACCOUNT_YIELDS_V4_SOURCES) {
    targets.push(col);
    sources.push(cols.has(col) ? col : cols.has(from) ? from : '0');
  }

  const run = db.transaction(() => {
    // 索引名会跟着被 RENAME 的表走，必须先显式删掉，
    // 否则后面 CREATE INDEX IF NOT EXISTS 会因"名字已存在"而空转，新表拿不到索引。
    db.exec('DROP INDEX IF EXISTS idx_yield_year;');
    db.exec(`ALTER TABLE accountYields RENAME TO ${ACCOUNT_YIELDS_LEGACY_TABLE};`);
    db.exec(ACCOUNT_YIELDS_V4_SQL);
    db.prepare(
      `INSERT INTO accountYields (${targets.join(', ')})
       SELECT ${sources.join(', ')} FROM ${ACCOUNT_YIELDS_LEGACY_TABLE};`,
    ).run();
    db.exec(`DROP TABLE ${ACCOUNT_YIELDS_LEGACY_TABLE};`);
    db.exec(YIELD_YEAR_INDEX_SQL);
  });
  run();
  return true;
}

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
  // 重建必须先于补列（见文件头注释）
  ensureNotificationsShape(db);
  ensureAiInsightNotificationsShape(db);
  ensureAccountYieldsShape(db);
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
