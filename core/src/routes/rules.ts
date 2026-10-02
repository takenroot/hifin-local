/**
 * /api/rules 路由 — 交易自动分类规则 CRUD
 * - GET    列表，可按 enabled / categoryId 过滤（按 priority DESC, id ASC 排序）
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * 注意：rules 表没有 spaceId 列（规则是全局的导入侧配置），因此不提供空间过滤。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { RuleRow, RuleMatchField } from '../db/schema.js';

export const rulesRouter = Router();

const VALID_FIELDS: RuleMatchField[] = ['name', 'merchant', 'remark'];

function nowMs(): number {
  return Date.now();
}

/** 解析 query 里的布尔开关（enabled）。 */
function parseEnabled(input: unknown): boolean | null {
  if (input === undefined) return null;
  const s = String(input).toLowerCase();
  if (s === '1' || s === 'true') return true;
  if (s === '0' || s === 'false') return false;
  return null;
}

/** GET /api/rules?enabled=1&categoryId=3 */
rulesRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];

  if (req.query.enabled !== undefined) {
    const en = parseEnabled(req.query.enabled);
    if (en === null) {
      res.status(400).json({ error: 'enabled 必须是 true/false/1/0' });
      return;
    }
    where.push('enabled = ?');
    params.push(en ? 1 : 0);
  }
  if (req.query.categoryId !== undefined) {
    const cid = Number(req.query.categoryId);
    if (!Number.isFinite(cid)) {
      res.status(400).json({ error: 'categoryId 必须是数字' });
      return;
    }
    where.push('categoryId = ?');
    params.push(cid);
  }

  const sql = `SELECT * FROM rules ${
    where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY priority DESC, id ASC`;
  const rows = db.prepare(sql).all(...params) as RuleRow[];
  res.json(rows);
});

/** POST /api/rules */
rulesRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const keyword = String(body.keyword ?? '').trim();
  const matchField = String(body.matchField ?? '') as RuleMatchField;
  const categoryId = Number(body.categoryId);
  const priority = body.priority !== undefined ? Number(body.priority) : 0;
  const enabled = body.enabled === undefined ? 1 : body.enabled ? 1 : 0;

  if (!keyword) {
    res.status(400).json({ error: 'keyword 必填' });
    return;
  }
  if (!VALID_FIELDS.includes(matchField)) {
    res.status(400).json({ error: `matchField 必须是 ${VALID_FIELDS.join('/')}` });
    return;
  }
  if (!Number.isFinite(categoryId)) {
    res.status(400).json({ error: 'categoryId 必填且必须是数字' });
    return;
  }
  if (!Number.isFinite(priority)) {
    res.status(400).json({ error: 'priority 必须是数字' });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(keyword, matchField, categoryId, priority, enabled, nowMs());

  const row = db
    .prepare('SELECT * FROM rules WHERE id = ?')
    .get(result.lastInsertRowid) as RuleRow;
  res.status(201).json(row);
});

/** PUT /api/rules/:id */
rulesRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as
    | RuleRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.keyword !== undefined) {
    const k = String(body.keyword).trim();
    if (!k) {
      res.status(400).json({ error: 'keyword 不能为空' });
      return;
    }
    updates.push('keyword = ?');
    params.push(k);
  }
  if (body.matchField !== undefined) {
    const f = String(body.matchField) as RuleMatchField;
    if (!VALID_FIELDS.includes(f)) {
      res.status(400).json({ error: `matchField 必须是 ${VALID_FIELDS.join('/')}` });
      return;
    }
    updates.push('matchField = ?');
    params.push(f);
  }
  if (body.categoryId !== undefined) {
    const c = Number(body.categoryId);
    if (!Number.isFinite(c)) {
      res.status(400).json({ error: 'categoryId 必须是数字' });
      return;
    }
    updates.push('categoryId = ?');
    params.push(c);
  }
  if (body.priority !== undefined) {
    const p = Number(body.priority);
    if (!Number.isFinite(p)) {
      res.status(400).json({ error: 'priority 必须是数字' });
      return;
    }
    updates.push('priority = ?');
    params.push(p);
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    params.push(body.enabled ? 1 : 0);
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }
  params.push(id);
  db.prepare(`UPDATE rules SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as RuleRow;
  res.json(row);
});

/** DELETE /api/rules/:id */
rulesRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM rules WHERE id = ?').get(id) as
    | RuleRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '规则不存在' });
    return;
  }
  db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  res.status(204).end();
});
