/**
 * /api/ai-models 路由 — AI 模型配置 CRUD
 * - GET    列表，可按 q（名称模糊匹配）过滤
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * 注意：aiModels 表没有 spaceId 列（模型配置是全局的），因此不提供空间过滤。
 * GET 默认不返回 apiKey 全文，用 hideApiKey=0 显式要求明文返回。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { AiModelRow } from '../db/schema.js';

export const aiModelsRouter = Router();

/** 列表/单条 → 对外响应：默认脱敏 apiKey。 */
function toResponse(
  row: AiModelRow,
  revealApiKey: boolean,
): Omit<AiModelRow, 'apiKey'> & { apiKey: string | null; hasApiKey: boolean } {
  const hasApiKey =
    row.apiKey !== undefined && row.apiKey !== null && row.apiKey !== '';
  const { apiKey, ...rest } = row;
  return {
    ...rest,
    apiKey: revealApiKey ? (apiKey ?? null) : null,
    hasApiKey,
  };
}

/** GET /api/ai-models?q=关键&hideApiKey=0 */
aiModelsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const reveal = String(req.query.hideApiKey ?? '1') === '0';
  const q = req.query.q;
  let rows: AiModelRow[];
  if (q !== undefined) {
    const kw = String(q).trim();
    if (!kw) {
      res.status(400).json({ error: 'q 不能为空' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM aiModels WHERE name LIKE ? ORDER BY id ASC')
      .all(`%${kw}%`) as AiModelRow[];
  } else {
    rows = db.prepare('SELECT * FROM aiModels ORDER BY id ASC').all() as AiModelRow[];
  }
  res.json(rows.map((r) => toResponse(r, reveal)));
});

/** POST /api/ai-models */
aiModelsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const model = String(body.model ?? '').trim();
  const endpoint = String(body.endpoint ?? '').trim();

  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  if (!model) {
    res.status(400).json({ error: 'model 必填' });
    return;
  }
  if (!endpoint) {
    res.status(400).json({ error: 'endpoint 必填' });
    return;
  }

  const result = db
    .prepare('INSERT INTO aiModels (name, model, endpoint, apiKey) VALUES (?, ?, ?, ?)')
    .run(name, model, endpoint, body.apiKey !== undefined ? String(body.apiKey) : null);

  const row = db
    .prepare('SELECT * FROM aiModels WHERE id = ?')
    .get(result.lastInsertRowid) as AiModelRow;
  // 写操作回显完整配置，方便调用方确认写入结果
  res.status(201).json(toResponse(row, true));
});

/** PUT /api/ai-models/:id */
aiModelsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM aiModels WHERE id = ?').get(id) as
    | AiModelRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'AI 模型不存在' });
    return;
  }

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) {
      res.status(400).json({ error: 'name 不能为空' });
      return;
    }
    updates.push('name = ?');
    params.push(n);
  }
  if (body.model !== undefined) {
    const m = String(body.model).trim();
    if (!m) {
      res.status(400).json({ error: 'model 不能为空' });
      return;
    }
    updates.push('model = ?');
    params.push(m);
  }
  if (body.endpoint !== undefined) {
    const e = String(body.endpoint).trim();
    if (!e) {
      res.status(400).json({ error: 'endpoint 不能为空' });
      return;
    }
    updates.push('endpoint = ?');
    params.push(e);
  }
  if (body.apiKey !== undefined) {
    updates.push('apiKey = ?');
    params.push(body.apiKey === null ? null : String(body.apiKey));
  }

  if (updates.length === 0) {
    res.json(toResponse(existing, true));
    return;
  }
  params.push(id);
  db.prepare(`UPDATE aiModels SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM aiModels WHERE id = ?').get(id) as AiModelRow;
  res.json(toResponse(row, true));
});

/** DELETE /api/ai-models/:id */
aiModelsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM aiModels WHERE id = ?').get(id) as
    | AiModelRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: 'AI 模型不存在' });
    return;
  }
  db.prepare('DELETE FROM aiModels WHERE id = ?').run(id);
  res.status(204).end();
});
