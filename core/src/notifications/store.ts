/**
 * notifications 表的数据访问层。
 *
 * 表定义在 src/db/schema.ts（勿改），这里只封装读写：
 *   - createNotification    落一条待处理通知（轮询器发现需要密码/导入失败时调用）
 *   - listNotifications     列表查询，支持按 status / type 过滤
 *   - resolveNotification   标记已解决（用户提交密码、导入成功、收益率已补填）
 *   - dismissNotification   用户忽略
 *   - expireNotification    窗口过期（收益率催填到 2 月 1 日还没填）
 *   - incrementRetry        密码重试计数 +1，返回新的 retry_count（3 次上限判定见设计文档）
 *   - parseNotificationPayload  解析 v3 新增的 payload 列，脏数据返回 null
 *
 * 约定：所有写操作自动维护 updatedAt；不抛"不存在"以外的异常语义之外的东西，
 * 找不到行时抛 NotFoundError，由路由层转 404。
 */
import type Database from 'better-sqlite3';
import type {
  NotificationRow,
  NotificationStatus,
  NotificationType,
} from '../db/schema.js';

/** schema.ts 里的 CHECK 约束，同步一份用于入参校验，避免直接吃到 SQLite 报错 */
export const NOTIFICATION_TYPES: NotificationType[] = [
  'need_password',
  'password_error',
  'import_success',
  'import_failed',
  'yield-reminder',
];

export const NOTIFICATION_STATUSES: NotificationStatus[] = [
  'pending',
  'resolved',
  'dismissed',
  'failed',
  'expired',
];

/** 创建通知时的可选字段 */
export interface CreateNotificationInput {
  type: NotificationType;
  title: string;
  message?: string;
  /** 关联的邮件 UID（schema 字段名是 snake_case 的 bill_uid） */
  bill_uid?: number;
  platform?: string;
  /**
   * 业务载荷（v3 新增的 payload 列，JSON 文本）。
   * 传对象/数组会自动 JSON.stringify；已序列化的字符串原样落库；
   * undefined → NULL。只有 yield-reminder 用它装 {accountId, year}。
   */
  payload?: unknown;
}

/** listNotifications 的过滤条件 */
export interface ListNotificationsFilter {
  status?: NotificationStatus;
  type?: NotificationType;
  limit?: number;
}

/** 目标行不存在时抛出，路由层捕获后返回 404 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

function nowMs(): number {
  return Date.now();
}

function isPositiveInt(n: number): boolean {
  return Number.isInteger(n) && n > 0;
}

/** 校验并规范 id；非法直接抛（路由层先做 400，这里兜底） */
function assertId(id: number): number {
  if (!isPositiveInt(id)) {
    throw new Error(`通知 id 必须是正整数，收到：${String(id)}`);
  }
  return id;
}

/**
 * 规范 payload：对象/数组 → JSON 文本；字符串原样（允许调用方自己序列化好）；
 * undefined/null → null（不写这一列的语义）。其余类型（number/boolean）
 * 也允许，统一转成 JSON 文本，免得因为调用方传了个裸数字就炸掉。
 */
function normalizePayload(payload: unknown): string | null {
  if (payload === undefined || payload === null) return null;
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload);
}

/**
 * 解析 payload 文本成对象；NULL / 空串 / 非法 JSON 一律返回 null。
 * 读侧永远不该因为一条脏数据把整个列表接口带崩。
 */
export function parseNotificationPayload(row: {
  payload?: string | null;
}): Record<string, unknown> | null {
  const raw = row?.payload;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function assertStatus(status: NotificationStatus): NotificationStatus {
  if (!NOTIFICATION_STATUSES.includes(status)) {
    throw new Error(`status 必须是 ${NOTIFICATION_STATUSES.join('/')}，收到：${String(status)}`);
  }
  return status;
}

function assertType(type: NotificationType): NotificationType {
  if (!NOTIFICATION_TYPES.includes(type)) {
    throw new Error(`type 必须是 ${NOTIFICATION_TYPES.join('/')}，收到：${String(type)}`);
  }
  return type;
}

/** 读一行；不存在返回 undefined */
function findById(db: Database.Database, id: number): NotificationRow | undefined {
  return db.prepare('SELECT * FROM notifications WHERE id = ?').get(id) as
    | NotificationRow
    | undefined;
}

/** 读一行；不存在抛 NotFoundError */
function getOrThrow(db: Database.Database, id: number): NotificationRow {
  const row = findById(db, id);
  if (!row) throw new NotFoundError(`通知不存在：${id}`);
  return row;
}

/**
 * 新建一条通知，默认 status=pending / retry_count=0（交给 schema 默认值）。
 * 返回落库后的完整行（含自增 id）。
 */
export function createNotification(
  db: Database.Database,
  input: CreateNotificationInput,
): NotificationRow {
  const type = assertType(input.type);
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('title 必填');

  const message = input.message === undefined ? null : String(input.message);
  const billUid = input.bill_uid === undefined ? null : Number(input.bill_uid);
  if (billUid !== null && !Number.isFinite(billUid)) {
    throw new Error(`bill_uid 必须是数字，收到：${String(input.bill_uid)}`);
  }
  const platform = input.platform === undefined ? null : String(input.platform);
  const payload = normalizePayload(input.payload);

  const ts = nowMs();
  const result = db
    .prepare(
      `INSERT INTO notifications (type, title, message, bill_uid, platform, status, retry_count, createdAt, updatedAt, payload)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
    )
    .run(type, title, message, billUid, platform, ts, ts, payload);

  return getOrThrow(db, Number(result.lastInsertRowid));
}

/**
 * 列表查询；不传过滤条件时返回全部，按 createdAt DESC / id DESC 排序（新的在前）。
 * 路由层已经校验过 status/type 的合法性，这里再挡一道，避免拼进 SQL 的值不受控。
 */
export function listNotifications(
  db: Database.Database,
  filter: ListNotificationsFilter = {},
): NotificationRow[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(assertStatus(filter.status));
  }
  if (filter.type !== undefined) {
    where.push('type = ?');
    params.push(assertType(filter.type));
  }

  let sql = 'SELECT * FROM notifications';
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ' ORDER BY createdAt DESC, id DESC';

  if (filter.limit !== undefined) {
    const limit = Number(filter.limit);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new Error(`limit 必须是正整数，收到：${String(filter.limit)}`);
    }
    sql += ' LIMIT ?';
    params.push(limit);
  }

  return db.prepare(sql).all(...params) as NotificationRow[];
}

/** 按 id 读一条；不存在返回 undefined */
export function getNotification(db: Database.Database, id: number): NotificationRow | undefined {
  return findById(db, assertId(id));
}

/** 标记已解决：status → resolved，并维护 updatedAt。不存在抛 NotFoundError */
export function resolveNotification(db: Database.Database, id: number): void {
  const target = assertId(id);
  getOrThrow(db, target);
  db.prepare(`UPDATE notifications SET status = 'resolved', updatedAt = ? WHERE id = ?`).run(
    nowMs(),
    target,
  );
}

/** 用户忽略：status → dismissed，并维护 updatedAt。不存在抛 NotFoundError */
export function dismissNotification(db: Database.Database, id: number): void {
  const target = assertId(id);
  getOrThrow(db, target);
  db.prepare(`UPDATE notifications SET status = 'dismissed', updatedAt = ? WHERE id = ?`).run(
    nowMs(),
    target,
  );
}

/**
 * 窗口过期：status → expired，并维护 updatedAt。不存在抛 NotFoundError。
 *
 * expired 与 resolved 的区别是**语义**而非展示：resolved 是"用户做完了"
 * （催填类通知里就是用户补了收益率），expired 是"这件事到此为止、用户没做"。
 * 两者都不再出现在 pending 列表里，所以对用户来说都是"不再打扰"。
 */
export function expireNotification(db: Database.Database, id: number): void {
  const target = assertId(id);
  getOrThrow(db, target);
  db.prepare(`UPDATE notifications SET status = 'expired', updatedAt = ? WHERE id = ?`).run(
    nowMs(),
    target,
  );
}

/**
 * 密码重试计数 +1，返回新的 retry_count。
 * 只动计数和 updatedAt，不改 status——「retry_count >= 3 转 failed」由状态机那层判定。
 */
export function incrementRetry(db: Database.Database, id: number): number {
  const target = assertId(id);
  getOrThrow(db, target);
  db.prepare(
    'UPDATE notifications SET retry_count = retry_count + 1, updatedAt = ? WHERE id = ?',
  ).run(nowMs(), target);
  const row = db
    .prepare('SELECT retry_count FROM notifications WHERE id = ?')
    .get(target) as { retry_count: number } | undefined;
  if (!row) throw new NotFoundError(`通知不存在：${target}`);
  return row.retry_count;
}
