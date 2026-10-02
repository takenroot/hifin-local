/**
 * /api/categories 路由 — 分类 CRUD（仅 GET + POST）
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { CategoryRow, CategoryType } from '../db/schema.js';

export const categoriesRouter = Router();

const VALID_TYPES: CategoryType[] = ['expense', 'income'];

/** GET /api/categories */
categoriesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM categories ORDER BY id ASC')
    .all() as CategoryRow[];
  res.json(rows);
});

/** POST /api/categories */
categoriesRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const group = String(body.group ?? '').trim();
  const type = String(body.type ?? '') as CategoryType;
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  if (!group) {
    res.status(400).json({ error: 'group 必填' });
    return;
  }
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
    return;
  }
  const icon = body.icon !== undefined ? String(body.icon) : null;
  const color = body.color !== undefined ? String(body.color) : null;

  const result = db
    .prepare(
      `INSERT INTO categories (name, "group", type, icon, color)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(name, group, type, icon, color);

  const row = db
    .prepare('SELECT * FROM categories WHERE id = ?')
    .get(result.lastInsertRowid) as CategoryRow;
  res.status(201).json(row);
});
