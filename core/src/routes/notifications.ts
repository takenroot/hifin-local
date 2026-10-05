/**
 * /api/notifications 路由 — 账单自动化通知的读写接口
 * - GET  /api/notifications?status=pending&type=need_password  列表（前端 30s 轮询这个）
 * - POST /api/notifications/:id/resolve   标记已解决
 * - POST /api/notifications/:id/dismiss   用户忽略
 *
 * 状态流转与 schema 见 src/db/schema.ts，业务逻辑在 src/notifications/store.ts。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import {
  listNotifications,
  resolveNotification,
  dismissNotification,
  getNotification,
  NotFoundError,
  NOTIFICATION_STATUSES,
  NOTIFICATION_TYPES,
} from '../notifications/store.js';
import { subscribe } from '../notifications/bus.js';
import type { NotificationRow, NotificationStatus, NotificationType } from '../db/schema.js';

export const notificationsRouter = Router();

/** 解析 :id，非法返回 null（交给调用方回 400） */
function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** store 抛 NotFoundError → 404；其它异常 → 500（对齐 server.ts 的错误体格式） */
function respondStoreError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
}

/** GET /api/notifications?status=&type=&limit= */
notificationsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { status, type, limit } = req.query;

  if (status !== undefined && !NOTIFICATION_STATUSES.includes(status as NotificationStatus)) {
    res.status(400).json({ error: `status 必须是 ${NOTIFICATION_STATUSES.join('/')}` });
    return;
  }
  if (type !== undefined && !NOTIFICATION_TYPES.includes(type as NotificationType)) {
    res.status(400).json({ error: `type 必须是 ${NOTIFICATION_TYPES.join('/')}` });
    return;
  }
  if (limit !== undefined) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n <= 0) {
      res.status(400).json({ error: 'limit 必须是正整数' });
      return;
    }
  }

  const rows = listNotifications(db, {
    status: status as NotificationStatus | undefined,
    type: type as NotificationType | undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
  });
  res.json(rows);
});

/**
 * GET /api/notifications/stream — SSE 实时通知流
 * ---------------------------------------------------------------
 * 详见 docs/sse-design.md §2.2.3。要点：
 *  - 立即 flushHeaders 让 Vite dev proxy 不缓冲首字节
 *  - 25s 心跳注释行避开常见 30s/60s 反代超时
 *  - req close/aborted 都触发清理（同一个 cleanup 即可）
 *  - 当前项目无鉴权，与现有路由保持一致
 *
 * 注意：必须放在 /:id 之前注册，否则会被 :id 误匹配（'stream' 不是合法数字 → 400）
 */
notificationsRouter.get('/stream', (req: Request, res: Response) => {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // 首次连接立刻送 hello，客户端用它确认建立
  res.write(`event: hello\ndata: {"ts":${Date.now()}}\n\n`);

  // 25s 心跳；避开 30s/60s 反代超时阈值
  const heartbeat = setInterval(() => {
    try {
      res.write(`: keepalive ${Date.now()}\n\n`);
    } catch {
      /* 已断，下次 req.close 兜底清理 */
    }
  }, 25_000);

  const unsub = subscribe((ev) => {
    const payload = JSON.stringify(ev);
    try {
      if (ev.kind === 'created') {
        res.write(`event: notification\nid: ${ev.notification.id}\ndata: ${payload}\n\n`);
      } else {
        res.write(`event: ${ev.kind}\nid: ${ev.id}\ndata: ${payload}\n\n`);
      }
    } catch {
      /* 已断，留给 req.close 兜底 */
    }
  });

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    unsub();
    try {
      res.end();
    } catch {
      /* noop */
    }
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});

/** GET /api/notifications/:id — 单条详情（弹窗刷新用） */
notificationsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const row: NotificationRow | undefined = getNotification(db, id);
  if (!row) {
    res.status(404).json({ error: `通知不存在：${id}` });
    return;
  }
  res.json(row);
});

/** POST /api/notifications/:id/resolve — 标记已解决，返回更新后的行 */
notificationsRouter.post('/:id/resolve', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  try {
    resolveNotification(db, id);
  } catch (err) {
    respondStoreError(res, err);
    return;
  }
  res.json(getNotification(db, id));
});

/** POST /api/notifications/:id/dismiss — 用户忽略，返回更新后的行 */
notificationsRouter.post('/:id/dismiss', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  try {
    dismissNotification(db, id);
  } catch (err) {
    respondStoreError(res, err);
    return;
  }
  res.json(getNotification(db, id));
});
