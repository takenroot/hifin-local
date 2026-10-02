/**
 * /api/reports 路由 — 报表模板 CRUD
 * - GET    列表
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * config 字段为 JSON 文本，存储时序列化、返回时反序列化为对象，
 * 对外始终以 JSON 值（对象/数组/标量）的形式暴露，不泄漏字符串形态。
 *
 * 注意：reports 表没有 spaceId 列（报表模板是全局实体），因此不提供空间过滤。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { ReportRow } from '../db/schema.js';

export const reportsRouter = Router();

function nowMs(): number {
  return Date.now();
}

/** 报表行 → 对外响应：config 反序列化为 JSON 值。 */
function toResponse(row: ReportRow): Omit<ReportRow, 'config'> & { config: unknown } {
  let config: unknown = null;
  if (row.config !== undefined && row.config !== null && row.config !== '') {
    try {
      config = JSON.parse(row.config);
    } catch {
      // 脏数据（非法 JSON）时原样返回字符串，不让整个列表挂掉
      config = row.config;
    }
  }
  return { ...row, config };
}

/**
 * 入参 config → 存储用 JSON 文本。
 * - undefined / null → null
 * - string：必须是合法 JSON 文本（允许调用方直接传已序列化的字符串）
 * - 其它任意 JSON 值 → JSON.stringify
 */
function serializeConfig(input: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input === 'string') {
    try {
      JSON.parse(input);
    } catch {
      // 允许非 JSON 字符串原样存储（向后兼容纯文本 config）
      return { ok: true, value: input };
    }
    return { ok: true, value: input };
  }
  try {
    return { ok: true, value: JSON.stringify(input) };
  } catch {
    return { ok: false, error: 'config 必须是可序列化的 JSON' };
  }
}

/** GET /api/reports */
reportsRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM reports ORDER BY id ASC').all() as ReportRow[];
  res.json(rows.map(toResponse));
});

/** POST /api/reports */
reportsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  const cfg = serializeConfig(body.config);
  if (!cfg.ok) {
    res.status(400).json({ error: cfg.error });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO reports (name, description, template, icon, config, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      body.description !== undefined ? String(body.description) : null,
      body.template !== undefined ? String(body.template) : null,
      body.icon !== undefined ? String(body.icon) : null,
      cfg.value,
      nowMs(),
    );

  const row = db
    .prepare('SELECT * FROM reports WHERE id = ?')
    .get(result.lastInsertRowid) as ReportRow;
  res.status(201).json(toResponse(row));
});

/** PUT /api/reports/:id */
reportsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
    | ReportRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '报表不存在' });
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
  if (body.description !== undefined) {
    updates.push('description = ?');
    params.push(body.description === null ? null : String(body.description));
  }
  if (body.template !== undefined) {
    updates.push('template = ?');
    params.push(body.template === null ? null : String(body.template));
  }
  if (body.icon !== undefined) {
    updates.push('icon = ?');
    params.push(body.icon === null ? null : String(body.icon));
  }
  if (body.config !== undefined) {
    const cfg = serializeConfig(body.config);
    if (!cfg.ok) {
      res.status(400).json({ error: cfg.error });
      return;
    }
    updates.push('config = ?');
    params.push(cfg.value);
  }

  if (updates.length === 0) {
    res.json(toResponse(existing));
    return;
  }
  params.push(id);
  db.prepare(`UPDATE reports SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as ReportRow;
  res.json(toResponse(row));
});

/** DELETE /api/reports/:id */
reportsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM reports WHERE id = ?').get(id) as
    | ReportRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '报表不存在' });
    return;
  }
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  res.status(204).end();
});
