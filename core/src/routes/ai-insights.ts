/**
 * /api/ai-insights 路由 — 自动财务洞察的 REST 接口
 * ---------------------------------------------------------------
 * 5 个端点：
 *  - GET    /              列表（复用 listNotifications(type='ai-insight', status?)）
 *  - GET    /:id           单条详情
 *  - POST   /:id/resolve   标记已解决（复用 resolveNotification）
 *  - POST   /:id/dismiss   用户忽略（复用 dismissNotification）
 *  - POST   /generate?month=YYYY-MM   手动触发（复用 ensureManualInsight）
 *
 * 与 /api/notifications 完全同形：前端代码只需把 URL 前缀换一下。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import {
  getNotification,
  listNotifications,
  resolveNotification,
  dismissNotification,
  NotFoundError,
  NOTIFICATION_STATUSES,
} from '../notifications/store.js';
import type { NotificationStatus, NotificationRow } from '../db/schema.js';
import {
  ensureManualInsight,
  AI_INSIGHT_TYPE,
  monthOfToday,
} from '../insights/scheduler.js';

export const aiInsightsRouter = Router();

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function respondStoreError(res: Response, err: unknown): void {
  if (err instanceof NotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
}

/** GET /api/ai-insights?status=&limit= */
aiInsightsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { status, limit } = req.query;

  if (status !== undefined && !NOTIFICATION_STATUSES.includes(status as NotificationStatus)) {
    res.status(400).json({ error: `status 必须是 ${NOTIFICATION_STATUSES.join('/')}` });
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
    type: AI_INSIGHT_TYPE,
    status: status as NotificationStatus | undefined,
    limit: limit !== undefined ? Number(limit) : undefined,
  });
  res.json(rows);
});

/** GET /api/ai-insights/:id — 单条详情 */
aiInsightsRouter.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const row: NotificationRow | undefined = getNotification(db, id);
  if (!row || row.type !== AI_INSIGHT_TYPE) {
    res.status(404).json({ error: `洞察不存在：${id}` });
    return;
  }
  res.json(row);
});

/** POST /api/ai-insights/:id/resolve — 标记已解决 */
aiInsightsRouter.post('/:id/resolve', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const target = getNotification(db, id);
  if (!target || target.type !== AI_INSIGHT_TYPE) {
    res.status(404).json({ error: `洞察不存在：${id}` });
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

/** POST /api/ai-insights/:id/dismiss — 用户忽略 */
aiInsightsRouter.post('/:id/dismiss', (req: Request, res: Response) => {
  const db = getDb();
  const id = parseId(req.params.id);
  if (id === null) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const target = getNotification(db, id);
  if (!target || target.type !== AI_INSIGHT_TYPE) {
    res.status(404).json({ error: `洞察不存在：${id}` });
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

/**
 * POST /api/ai-insights/generate?month=YYYY-MM — 手动触发
 *  - 同月份已有且在去重窗口内：200 + reused（设计文档已决策：用户体感"点了就有"）
 *  - 本月手动配额用尽：429
 *  - 没有模型（不影响自动调度；手动也只能产规则版）：200 + skippedReason='no-model'
 */
aiInsightsRouter.post('/generate', (req: Request, res: Response) => {
  const db = getDb();
  const month = (req.query.month as string | undefined) ?? monthOfToday();
  if (!/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: 'month 必须是 YYYY-MM 格式' });
    return;
  }

  const run = ensureManualInsight(db, new Date(), month);
  if (run.skippedReason === 'quota-exceeded') {
    res.status(429).json({ error: '本月手动生成次数已用完，请下个月再试', month });
    return;
  }
  if (run.reused != null) {
    res.status(200).json({ id: run.reused, reused: true, month });
    return;
  }
  if (run.notificationId == null) {
    res.status(500).json({ error: 'insight generation produced no id', month });
    return;
  }
  res.status(201).json({
    id: run.notificationId,
    reused: false,
    llmAttempted: run.llmAttempted,
    skippedReason: run.skippedReason ?? null,
    month,
  });
});