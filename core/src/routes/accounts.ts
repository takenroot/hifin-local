/**
 * /api/accounts 路由 — 账户 CRUD
 * - GET    列表，可按 spaceId 过滤
 * - POST   创建
 * - PUT    更新（name / type / balance / remark / tagIds / includeInNetAsset / spaceId）
 * - DELETE 删除
 *
 * 复用 src/db 模块的 getDb() 获取 better-sqlite3 实例。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { AccountRow, AccountType } from '../db/schema.js';

export const accountsRouter = Router();

const VALID_TYPES: AccountType[] = [
  'fund', 'asset', 'social', 'invest', 'other', 'credit', 'debt',
];

function nowMs(): number {
  return Date.now();
}

function parseTagIds(input: unknown): string | undefined {
  if (input === undefined || input === null) return undefined;
  if (Array.isArray(input)) return JSON.stringify(input);
  if (typeof input === 'string') {
    try {
      const arr = JSON.parse(input);
      if (Array.isArray(arr)) return JSON.stringify(arr);
    } catch {
      /* fallthrough */
    }
    return input;
  }
  return undefined;
}

/** GET /api/accounts?spaceId=N */
accountsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const spaceId = req.query.spaceId;
  let rows: AccountRow[];
  if (spaceId !== undefined) {
    const sid = Number(spaceId);
    if (!Number.isFinite(sid)) {
      res.status(400).json({ error: 'spaceId 必须是数字' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM accounts WHERE spaceId = ? ORDER BY id ASC')
      .all(sid) as AccountRow[];
  } else {
    rows = db
      .prepare('SELECT * FROM accounts ORDER BY id ASC')
      .all() as AccountRow[];
  }
  res.json(rows);
});

/** POST /api/accounts */
accountsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const name = String(body.name ?? '').trim();
  const type = String(body.type ?? '') as AccountType;
  const balance = Number(body.balance ?? 0);

  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
    return;
  }
  if (!Number.isFinite(balance)) {
    res.status(400).json({ error: 'balance 必须是数字' });
    return;
  }

  const ts = nowMs();
  const remark = body.remark !== undefined ? String(body.remark) : null;
  const tagIds = parseTagIds(body.tagIds);
  const includeInNetAsset =
    body.includeInNetAsset === undefined ? 1 : body.includeInNetAsset ? 1 : 0;
  const spaceId = body.spaceId !== undefined ? Number(body.spaceId) : 1;

  const result = db
    .prepare(
      `INSERT INTO accounts (name, type, balance, remark, tagIds, includeInNetAsset, spaceId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(name, type, balance, remark, tagIds ?? null, includeInNetAsset, spaceId, ts, ts);

  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(result.lastInsertRowid) as AccountRow;
  res.status(201).json(row);
});

/** PUT /api/accounts/:id */
accountsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(id) as AccountRow | undefined;
  if (!existing) {
    res.status(404).json({ error: '账户不存在' });
    return;
  }

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    params.push(String(body.name));
  }
  if (body.type !== undefined) {
    const t = String(body.type) as AccountType;
    if (!VALID_TYPES.includes(t)) {
      res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
      return;
    }
    updates.push('type = ?');
    params.push(t);
  }
  if (body.balance !== undefined) {
    const b = Number(body.balance);
    if (!Number.isFinite(b)) {
      res.status(400).json({ error: 'balance 必须是数字' });
      return;
    }
    updates.push('balance = ?');
    params.push(b);
  }
  if (body.remark !== undefined) {
    updates.push('remark = ?');
    params.push(body.remark === null ? null : String(body.remark));
  }
  if (body.tagIds !== undefined) {
    const t = parseTagIds(body.tagIds);
    updates.push('tagIds = ?');
    params.push(t ?? null);
  }
  if (body.includeInNetAsset !== undefined) {
    updates.push('includeInNetAsset = ?');
    params.push(body.includeInNetAsset ? 1 : 0);
  }
  if (body.spaceId !== undefined) {
    updates.push('spaceId = ?');
    params.push(Number(body.spaceId));
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }

  updates.push('updatedAt = ?');
  params.push(nowMs());
  params.push(id);

  db.prepare(`UPDATE accounts SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  const row = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(id) as AccountRow;
  res.json(row);
});

/** DELETE /api/accounts/:id */
accountsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM accounts WHERE id = ?')
    .get(id) as AccountRow | undefined;
  if (!existing) {
    res.status(404).json({ error: '账户不存在' });
    return;
  }
  // 关联交易保留但 accountId 留给用户后续处理；这里做硬删除
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  res.status(204).end();
});
