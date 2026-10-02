/**
 * /api/goals 路由 — 目标（储蓄 / 还债）CRUD
 * - GET    列表，可按 spaceId 过滤
 * - POST   创建
 * - PUT    更新
 * - DELETE 删除
 *
 * 账户余额联动口径（currentAmount ↔ accounts.balance）：
 *  目标关联 accountId 后，currentAmount 表示"该账户里为这个目标已经攒/还了多少钱"。
 *  - kind = 'saving'   → currentAmount 上升视为往目标账户存入，账户余额 +delta
 *  - kind = 'repayment' → currentAmount 上升视为从账户还款支出，账户余额 -delta
 *  delta 为负时方向相反（撤销/回退）。
 *
 * 所有读 + 写 + 余额更新用 better-sqlite3 transaction() 包裹，保证原子性；
 * 账户不存在时整体回滚。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { GoalRow, GoalKind } from '../db/schema.js';

export const goalsRouter = Router();

const VALID_KINDS: GoalKind[] = ['saving', 'repayment'];

function nowMs(): number {
  return Date.now();
}

/** 把账户 id 解析为 number | null；非法值返回 NaN 由调用方处理。 */
function parseAccountId(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const n = Number(input);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * 把"目标金额变动"折算成账户余额增量。
 * @param delta currentAmount 的变化量（新值 - 旧值）
 */
function balanceDeltaFor(kind: GoalKind, delta: number): number {
  return kind === 'saving' ? delta : -delta;
}

/** 校验账户存在；抛错由上层 transaction 回滚。 */
function assertAccountExists(accountId: number | null): void {
  if (accountId === null) return;
  const row = getDb().prepare('SELECT id FROM accounts WHERE id = ?').get(accountId);
  if (row === undefined) {
    const err = new Error(`账户不存在: ${accountId}`) as Error & { status: number };
    err.status = 400;
    throw err;
  }
}

/** 对账户余额施加一个增量（内部使用，调用方必须已开启 transaction）。 */
function applyBalanceDelta(accountId: number | null, delta: number): void {
  if (accountId === null || delta === 0) return;
  getDb()
    .prepare('UPDATE accounts SET balance = balance + ?, updatedAt = ? WHERE id = ?')
    .run(delta, nowMs(), accountId);
}

/** 撤销一个目标在账户上已经产生的余额贡献（内部使用）。 */
function revertContribution(row: GoalRow): void {
  if (row.accountId === undefined || row.accountId === null) return;
  applyBalanceDelta(
    row.accountId,
    balanceDeltaFor(row.kind, -row.currentAmount),
  );
}

/** GET /api/goals?spaceId=N */
goalsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const spaceId = req.query.spaceId;
  let rows: GoalRow[];
  if (spaceId !== undefined) {
    const sid = Number(spaceId);
    if (!Number.isFinite(sid)) {
      res.status(400).json({ error: 'spaceId 必须是数字' });
      return;
    }
    rows = db
      .prepare('SELECT * FROM goals WHERE spaceId = ? ORDER BY id ASC')
      .all(sid) as GoalRow[];
  } else {
    rows = db.prepare('SELECT * FROM goals ORDER BY id ASC').all() as GoalRow[];
  }
  res.json(rows);
});

/** POST /api/goals */
goalsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const kind = String(body.kind ?? '') as GoalKind;
  const name = String(body.name ?? '').trim();
  const targetAmount = Number(body.targetAmount ?? 0);
  const currentAmount = Number(body.currentAmount ?? 0);

  if (!VALID_KINDS.includes(kind)) {
    res.status(400).json({ error: `kind 必须是 ${VALID_KINDS.join('/')}` });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  if (!Number.isFinite(targetAmount) || !Number.isFinite(currentAmount)) {
    res.status(400).json({ error: 'targetAmount / currentAmount 必须是数字' });
    return;
  }
  const accountId = parseAccountId(body.accountId);
  if (Number.isNaN(accountId)) {
    res.status(400).json({ error: 'accountId 必须是数字' });
    return;
  }
  const deadline =
    body.deadline === undefined || body.deadline === null
      ? null
      : Number(body.deadline);
  if (deadline !== null && !Number.isFinite(deadline)) {
    res.status(400).json({ error: 'deadline 必须是数字' });
    return;
  }

  try {
    const newId = db.transaction(() => {
      assertAccountExists(accountId);
      const result = db
        .prepare(
          `INSERT INTO goals (kind, subtype, name, targetAmount, currentAmount, deadline, accountId, icon, color, spaceId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          kind,
          body.subtype !== undefined ? String(body.subtype) : null,
          name,
          targetAmount,
          currentAmount,
          deadline,
          accountId,
          body.icon !== undefined ? String(body.icon) : null,
          body.color !== undefined ? String(body.color) : null,
          body.spaceId !== undefined ? Number(body.spaceId) : 1,
          nowMs(),
        );
      // 新建时把已存在的 currentAmount 计入账户余额
      applyBalanceDelta(accountId, balanceDeltaFor(kind, currentAmount));
      return result.lastInsertRowid as number;
    })();

    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(newId) as GoalRow;
    res.status(201).json(row);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: (err as Error).message ?? 'internal error' });
  }
});

/** PUT /api/goals/:id */
goalsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
    | GoalRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '目标不存在' });
    return;
  }

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  let kind = existing.kind;
  if (body.kind !== undefined) {
    const k = String(body.kind) as GoalKind;
    if (!VALID_KINDS.includes(k)) {
      res.status(400).json({ error: `kind 必须是 ${VALID_KINDS.join('/')}` });
      return;
    }
    kind = k;
    updates.push('kind = ?');
    params.push(k);
  }

  let accountId: number | null = existing.accountId ?? null;
  if (body.accountId !== undefined) {
    const a = parseAccountId(body.accountId);
    if (Number.isNaN(a)) {
      res.status(400).json({ error: 'accountId 必须是数字' });
      return;
    }
    accountId = a;
    updates.push('accountId = ?');
    params.push(a);
  }

  let currentAmount = existing.currentAmount;
  if (body.currentAmount !== undefined) {
    const c = Number(body.currentAmount);
    if (!Number.isFinite(c)) {
      res.status(400).json({ error: 'currentAmount 必须是数字' });
      return;
    }
    currentAmount = c;
    updates.push('currentAmount = ?');
    params.push(c);
  }

  if (body.name !== undefined) {
    const n = String(body.name).trim();
    if (!n) {
      res.status(400).json({ error: 'name 不能为空' });
      return;
    }
    updates.push('name = ?');
    params.push(n);
  }
  if (body.subtype !== undefined) {
    updates.push('subtype = ?');
    params.push(body.subtype === null ? null : String(body.subtype));
  }
  if (body.targetAmount !== undefined) {
    const t = Number(body.targetAmount);
    if (!Number.isFinite(t)) {
      res.status(400).json({ error: 'targetAmount 必须是数字' });
      return;
    }
    updates.push('targetAmount = ?');
    params.push(t);
  }
  if (body.deadline !== undefined) {
    const d = body.deadline === null ? null : Number(body.deadline);
    if (d !== null && !Number.isFinite(d)) {
      res.status(400).json({ error: 'deadline 必须是数字' });
      return;
    }
    updates.push('deadline = ?');
    params.push(d);
  }
  if (body.icon !== undefined) {
    updates.push('icon = ?');
    params.push(body.icon === null ? null : String(body.icon));
  }
  if (body.color !== undefined) {
    updates.push('color = ?');
    params.push(body.color === null ? null : String(body.color));
  }
  if (body.spaceId !== undefined) {
    updates.push('spaceId = ?');
    params.push(Number(body.spaceId));
  }

  if (updates.length === 0) {
    res.json(existing);
    return;
  }

  try {
    db.transaction(() => {
      assertAccountExists(accountId);
      // 先撤销旧状态在旧账户上的贡献，再按新状态重新计入。
      // 账户/类型未变时两次操作自然相抵为 delta，账户变更时则完成迁移。
      revertContribution(existing);
      const nextRow: GoalRow = {
        ...existing,
        kind,
        accountId: accountId ?? undefined,
        currentAmount,
      };
      applyBalanceDelta(
        nextRow.accountId ?? null,
        balanceDeltaFor(nextRow.kind, nextRow.currentAmount),
      );

      params.push(id);
      db.prepare(`UPDATE goals SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    })();

    const row = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as GoalRow;
    res.json(row);
  } catch (err) {
    const status = (err as { status?: number }).status ?? 500;
    res.status(status).json({ error: (err as Error).message ?? 'internal error' });
  }
});

/** DELETE /api/goals/:id — 同时回滚账户余额贡献 */
goalsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db.prepare('SELECT * FROM goals WHERE id = ?').get(id) as
    | GoalRow
    | undefined;
  if (!existing) {
    res.status(404).json({ error: '目标不存在' });
    return;
  }
  db.transaction(() => {
    revertContribution(existing);
    db.prepare('DELETE FROM goals WHERE id = ?').run(id);
  })();
  res.status(204).end();
});
