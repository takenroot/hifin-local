/**
 * 通知模块的 REST 类型与归一化
 * ---------------------------------------------------------------
 * core 的 GET /api/notifications 直接 `SELECT *` 后 res.json，因此返回的是
 * **原始 SQLite 行**：可空列是 `null` 而不是 `undefined`，`retry_count` 缺省时
 * 可能是 `0` 也可能是 `null`。直接把这些行塞进 React 状态会让
 * `n.retry_count` 参与算术时得到 `null + 1 = 1` 这类静默错误，
 * 所以这里统一收敛成前端实体 `AppNotification`。
 *
 * 本文件不含 fetch，纯类型转换，便于测试。
 */

/** 与 core/src/db/schema.ts 的 NotificationType 保持一致 */
export type NotificationType =
  | 'need_password'
  | 'password_error'
  | 'import_success'
  | 'import_failed'
  /** 自动财务洞察（v5 新增）：title 固定为「本月财务小结」，payload 含 summary / sections / llmNarrative */
  | 'ai-insight';

/** 与 core/src/db/schema.ts 的 NotificationStatus 保持一致 */
export type NotificationStatus = 'pending' | 'resolved' | 'dismissed' | 'failed';

const TYPE_SET: readonly string[] = [
  'need_password',
  'password_error',
  'import_success',
  'import_failed',
  'ai-insight',
];

/** REST 返回的原始通知行（未归一化） */
export interface RestNotification {
  id?: number | null;
  type?: string | null;
  title?: string | null;
  message?: string | null;
  bill_uid?: number | null;
  platform?: string | null;
  status?: string | null;
  retry_count?: number | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  /** v3+ 通用业务载荷（JSON 文本）；ai-insight 用它装 summary / sections / llmNarrative */
  payload?: string | null;
}

/** 归一化后的前端通知实体 */
export interface AppNotification {
  id: number;
  type: NotificationType;
  title: string;
  message: string;
  /** 关联账单邮件 UID；没有就无法提交密码 */
  billUid?: number;
  platform: string;
  status: NotificationStatus;
  retryCount: number;
  createdAt: number;
  updatedAt: number;
  /** v3+ 通用业务载荷（已 JSON.parse 的对象）；ai-insight 用，其它类型可为空 */
  payload?: Record<string, unknown> | null;
}

/** 未知 type 一律丢弃：宁可少弹一个窗，也不要用错分支渲染 */
function toType(raw: unknown): NotificationType | null {
  return typeof raw === 'string' && TYPE_SET.includes(raw)
    ? (raw as NotificationType)
    : null;
}

/** SQLite 行 → AppNotification；缺少合法 id / type 的行返回 null */
export function toNotification(row: RestNotification | null | undefined): AppNotification | null {
  if (!row || typeof row !== 'object') return null;
  const type = toType(row.type);
  const id = typeof row.id === 'number' && Number.isFinite(row.id) ? row.id : null;
  if (type == null || id == null) return null;

  const now = Date.now();
  return {
    id,
    type,
    title: typeof row.title === 'string' ? row.title : '',
    message: typeof row.message === 'string' ? row.message : '',
    billUid: typeof row.bill_uid === 'number' && Number.isFinite(row.bill_uid)
      ? row.bill_uid
      : undefined,
    platform: typeof row.platform === 'string' ? row.platform : '',
    status: (typeof row.status === 'string' ? row.status : 'pending') as NotificationStatus,
    // ⚠️ 必须是兜底成 0：retry_count 直接参与 "还剩几次" 的算术
    retryCount: typeof row.retry_count === 'number' && Number.isFinite(row.retry_count)
      ? row.retry_count
      : 0,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : now,
    payload: parsePayloadField(row.payload),
  };
}

/** 解析 payload 字段：脏 JSON 一律容错为 null，不让列表渲染整页翻车 */
function parsePayloadField(raw: unknown): Record<string, unknown> | null {
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

/**
 * GET 列表响应 → AppNotification[]。
 *
 * 容错说明：core 侧 `GET /api/notifications` 的列表外壳（裸数组 / {items} /
 * {data} / {notifications} / {rows}）由并行的后端任务定稿，这里把常见外壳
 * 都接受掉，避免因为包裹层不同导致前端一条通知都渲染不出来。
 */
export function toNotificationList(raw: unknown): AppNotification[] {
  let rows: unknown = raw;
  if (!Array.isArray(rows) && rows && typeof rows === 'object') {
    const obj = raw as Record<string, unknown>;
    rows = obj.items ?? obj.data ?? obj.notifications ?? obj.rows ?? obj.list;
  }
  if (!Array.isArray(rows)) return [];

  const out: AppNotification[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const n = toNotification(r as RestNotification);
    // 同一次响应里 id 重复时保留第一条，避免同一通知弹两次窗
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}
