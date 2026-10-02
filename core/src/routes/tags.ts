/**
 * /api/tags 路由 — 标签 CRUD
 * - GET    列表，可按 q（名称模糊匹配）过滤
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * 注意：tags 表没有 spaceId 列（标签是全局实体，被 accounts.tagIds / transactions.tagIds 引用），
 * 因此这里不提供空间过滤，改为提供名称搜索。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { TagRow } from '../db/schema.js';

export const tagsRouter = Router();

/** GET /api/tags?q=关键 */
tagsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const q = req.query.q;
  let rows: TagRow[];
  if (q !== undefined) {
    const kw = String(q).trim();
    if (!kw) {
      res.status(400).json({ error: 'q 不能为空' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM tags WHERE name LIKE ? ORDER BY id ASC')
      .all(`%${kw}%`) as TagRow[];
  } else {
    rows = db.prepare('SELECT * FROM tags ORDER BY id ASC').all() as TagRow[];
  }
  res.json(rows);
});

/** POST /api/tags */
tagsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  const dup = db.prepare('SELECT id FROM tags WHERE name = ?').get(name);
  if (dup !== undefined) {
    res.status(409).json({ error: `标签已存在: ${name}` });
    return;
  }

  const result = db
    .prepare('INSERT INTO tags (name, color) VALUES (?, ?)')
    .run(name, body.color !== undefined ? String(body.color) : null);

  const row = db
    .prepare('SELECT * FROM tags WHERE id = ?')
    .get(result.lastInsertRowid) as TagRow;
  res.status(201).json(row);
});

/** PUT /api/tags/:id */
tagsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as
    | TagRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '标签不存在' });
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
    const dup = db
      .prepare('SELECT id FROM tags WHERE name = ? AND id != ?')
      .get(n, id);
    if (dup !== undefined) {
      res.status(409).json({ error: `标签已存在: ${n}` });
      return;
    }
    updates.push('name = ?');
    params.push(n);
  }
  if (body.color !== undefined) {
    updates.push('color = ?');
    params.push(body.color === null ? null : String(body.color));
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }
  params.push(id);
  db.prepare(`UPDATE tags SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as TagRow;
  res.json(row);
});

/** DELETE /api/tags/:id */
tagsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id) as
    | TagRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '标签不存在' });
    return;
  }
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  res.status(204).end();
});
