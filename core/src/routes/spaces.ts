/**
 * /api/spaces 路由 — 空间 CRUD
 * - GET    列表（附带各空间的统计：账户数 / 交易数 / 目标数 / 预算数）
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除（拒绝删除非空空间 + 拒绝删除默认空间 1）
 *
 * 空间是数据的顶层隔离维度：accounts / transactions / goals / budgets 都带 spaceId。
 * 删除空间时若任一关联表仍有该空间的数据，直接 409 拒绝，让用户先清理或迁移数据，
 * 避免出现"数据还在但空间没了"的孤儿记录。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { SpaceRow } from '../db/schema.js';

export const spacesRouter = Router();

/** 默认空间 id：seed 固定写入 id=1，且所有表 spaceId 默认 1，禁止删除。 */
const DEFAULT_SPACE_ID = 1;

/** 带 spaceId 的关联表 → 统计语句。 */
const CHILD_TABLES: Array<{ table: string; label: string }> = [
  { table: 'accounts', label: 'accounts' },
  { table: 'transactions', label: 'transactions' },
  { table: 'goals', label: 'goals' },
  { table: 'budgets', label: 'budgets' },
];

function nowMs(): number {
  return Date.now();
}

/** 统计某个空间下的关联数据量；用于列表与删除前的非空校验。 */
function childCounts(spaceId: number): Record<string, number> {
  const db = getDb();
  const out: Record<string, number> = {};
  for (const { table } of CHILD_TABLES) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE spaceId = ?`)
      .get(spaceId) as { n: number };
    out[table] = row.n;
  }
  return out;
}

/** 空间行 → 对外响应：附带 counts 统计。 */
function toResponse(row: SpaceRow): SpaceRow & { counts: Record<string, number> } {
  return { ...row, counts: childCounts(row.id as number) };
}

/** GET /api/spaces */
spacesRouter.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM spaces ORDER BY id ASC').all() as SpaceRow[];
  res.json(rows.map(toResponse));
});

/** POST /api/spaces */
spacesRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  const dup = db.prepare('SELECT id FROM spaces WHERE name = ?').get(name);
  if (dup !== undefined) {
    res.status(409).json({ error: `空间已存在: ${name}` });
    return;
  }

  const result = db
    .prepare('INSERT INTO spaces (name, createdAt) VALUES (?, ?)')
    .run(name, nowMs());

  const row = db
    .prepare('SELECT * FROM spaces WHERE id = ?')
    .get(result.lastInsertRowid) as SpaceRow;
  res.status(201).json(toResponse(row));
});

/** PUT /api/spaces/:id */
spacesRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as
    | SpaceRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '空间不存在' });
    return;
  }

  const body = req.body ?? {};
  if (body.name === undefined) {
    res.json(toResponse(existing));
    return;
  }
  const name = String(body.name).trim();
  if (!name) {
    res.status(400).json({ error: 'name 不能为空' });
    return;
  }
  const dup = db
    .prepare('SELECT id FROM spaces WHERE name = ? AND id != ?')
    .get(name, id);
  if (dup !== undefined) {
    res.status(409).json({ error: `空间已存在: ${name}` });
    return;
  }

  // createdAt 不可变，空间没有 updatedAt 列
  db.prepare('UPDATE spaces SET name = ? WHERE id = ?').run(name, id);
  const row = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as SpaceRow;
  res.json(toResponse(row));
});

/** DELETE /api/spaces/:id — 非空空间拒绝删除 */
spacesRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM spaces WHERE id = ?').get(id) as
    | SpaceRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '空间不存在' });
    return;
  }
  if (id === DEFAULT_SPACE_ID) {
    res.status(409).json({ error: `默认空间 (id=${DEFAULT_SPACE_ID}) 不允许删除` });
    return;
  }

  // 存在关联数据时拒绝删除；统计与删除放在同一事务内，避免 TOCTOU
  const deleteTx = db.transaction(() => {
    const counts = childCounts(id);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total > 0) {
      const detail = CHILD_TABLES.filter((t) => counts[t.table] > 0)
        .map((t) => `${t.label}=${counts[t.table]}`)
        .join(', ');
      const err = new Error(
        `空间「${existing.name}」非空，拒绝删除（${detail}）`,
      ) as Error & { status: number };
      err.status = 409;
      throw err;
    }
    db.prepare('DELETE FROM spaces WHERE id = ?').run(id);
  });

  try {
    deleteTx();
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: (err as Error).message ?? 'internal error' });
    return;
  }
  res.status(204).end();
});
