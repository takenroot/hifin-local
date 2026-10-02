/**
 * /api/budgets 路由 — 预算 CRUD
 * - GET    列表，可按 spaceId 过滤
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { BudgetRow, BudgetPeriod } from '../db/schema.js';

export const budgetsRouter = Router();

const VALID_PERIODS: BudgetPeriod[] = ['monthly', 'yearly'];

function nowMs(): number {
  return Date.now();
}

/** 解析可选的 categoryId：undefined/null → null，非法数字 → NaN。 */
function parseCategoryId(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : NaN;
}

/** GET /api/budgets?spaceId=N */
budgetsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const spaceId = req.query.spaceId;
  let rows: BudgetRow[];
  if (spaceId !== undefined) {
    const sid = Number(spaceId);
    if (!Number.isFinite(sid)) {
      res.status(400).json({ error: 'spaceId 必须是数字' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM budgets WHERE spaceId = ? ORDER BY id ASC')
      .all(sid) as BudgetRow[];
  } else {
    rows = db.prepare('SELECT * FROM budgets ORDER BY id ASC').all() as BudgetRow[];
  }
  res.json(rows);
});

/** POST /api/budgets */
budgetsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const period = String(body.period ?? '') as BudgetPeriod;
  const amount = Number(body.amount);

  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  if (!VALID_PERIODS.includes(period)) {
    res.status(400).json({ error: `period 必须是 ${VALID_PERIODS.join('/')}` });
    return;
  }
  if (!Number.isFinite(amount)) {
    res.status(400).json({ error: 'amount 必须是数字' });
    return;
  }
  const categoryId = parseCategoryId(body.categoryId);
  if (Number.isNaN(categoryId)) {
    res.status(400).json({ error: 'categoryId 必须是数字' });
    return;
  }

  const result = db
    .prepare(
      `INSERT INTO budgets (name, categoryId, amount, period, spaceId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      name,
      categoryId,
      amount,
      period,
      body.spaceId !== undefined ? Number(body.spaceId) : 1,
      nowMs(),
    );

  const row = db
    .prepare('SELECT * FROM budgets WHERE id = ?')
    .get(result.lastInsertRowid) as BudgetRow;
  res.status(201).json(row);
});

/** PUT /api/budgets/:id */
budgetsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as
    | BudgetRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '预算不存在' });
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
  if (body.amount !== undefined) {
    const a = Number(body.amount);
    if (!Number.isFinite(a)) {
      res.status(400).json({ error: 'amount 必须是数字' });
      return;
    }
    updates.push('amount = ?');
    params.push(a);
  }
  if (body.period !== undefined) {
    const p = String(body.period) as BudgetPeriod;
    if (!VALID_PERIODS.includes(p)) {
      res.status(400).json({ error: `period 必须是 ${VALID_PERIODS.join('/')}` });
      return;
    }
    updates.push('period = ?');
    params.push(p);
  }
  if (body.categoryId !== undefined) {
    const c = parseCategoryId(body.categoryId);
    if (Number.isNaN(c)) {
      res.status(400).json({ error: 'categoryId 必须是数字' });
      return;
    }
    updates.push('categoryId = ?');
    params.push(c);
  }
  if (body.spaceId !== undefined) {
    updates.push('spaceId = ?');
    params.push(Number(body.spaceId));
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }
  params.push(id);
  db.prepare(`UPDATE budgets SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow;
  res.json(row);
});

/** DELETE /api/budgets/:id */
budgetsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as
    | BudgetRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '预算不存在' });
    return;
  }
  db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
  res.status(204).end();
});
