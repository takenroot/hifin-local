/**
 * /api/merchants 路由 — 商户 CRUD
 * - GET    列表，可按 q（名称模糊匹配）过滤
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * 注意：merchants 表没有 spaceId 列（商户是全局实体，被 transactions.merchantId 引用），
 * 因此这里不提供空间过滤，改为提供名称搜索。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { MerchantRow } from '../db/schema.js';

export const merchantsRouter = Router();

/** GET /api/merchants?q=关键 */
merchantsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const q = req.query.q;
  let rows: MerchantRow[];
  if (q !== undefined) {
    const kw = String(q).trim();
    if (!kw) {
      res.status(400).json({ error: 'q 不能为空' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM merchants WHERE name LIKE ? ORDER BY id ASC')
      .all(`%${kw}%`) as MerchantRow[];
  } else {
    rows = db.prepare('SELECT * FROM merchants ORDER BY id ASC').all() as MerchantRow[];
  }
  res.json(rows);
});

/** POST /api/merchants */
merchantsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  const dup = db.prepare('SELECT id FROM merchants WHERE name = ?').get(name);
  if (dup !== undefined) {
    res.status(409).json({ error: `商户已存在: ${name}` });
    return;
  }

  const result = db
    .prepare('INSERT INTO merchants (name, remark) VALUES (?, ?)')
    .run(name, body.remark !== undefined ? String(body.remark) : null);

  const row = db
    .prepare('SELECT * FROM merchants WHERE id = ?')
    .get(result.lastInsertRowid) as MerchantRow;
  res.status(201).json(row);
});

/** PUT /api/merchants/:id */
merchantsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) as
    | MerchantRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '商户不存在' });
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
      .prepare('SELECT id FROM merchants WHERE name = ? AND id != ?')
      .get(n, id);
    if (dup !== undefined) {
      res.status(409).json({ error: `商户已存在: ${n}` });
      return;
    }
    updates.push('name = ?');
    params.push(n);
  }
  if (body.remark !== undefined) {
    updates.push('remark = ?');
    params.push(body.remark === null ? null : String(body.remark));
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }
  params.push(id);
  db.prepare(`UPDATE merchants SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db
    .prepare('SELECT * FROM merchants WHERE id = ?')
    .get(id) as MerchantRow;
  res.json(row);
});

/** DELETE /api/merchants/:id — 交易记录保留，merchantId 指向已删除商户 */
merchantsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM merchants WHERE id = ?').get(id) as
    | MerchantRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '商户不存在' });
    return;
  }
  db.prepare('DELETE FROM merchants WHERE id = ?').run(id);
  res.status(204).end();
});
