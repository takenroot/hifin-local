/**
 * /api/transactions 路由 — 交易 CRUD + 账户余额联动
 *
 * 余额联动规则（参考 app/src/features/transactions/balance.ts 口径）：
 *   - expense: account.balance -= amount
 *   - income:  account.balance += amount
 *   - transfer: account.balance -= amount; toAccount.balance += amount
 *   - excluded: 无影响
 *
 * 事务：所有读 + 写 + 余额更新用 better-sqlite3 transaction() 包裹，保证原子性。
 * 更新 / 删除：先按当前数据"回滚"对账户余额的影响，再应用新数据。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type {
  AccountRow,
  TransactionRow,
  TransactionType,
} from '../db/schema.js';

export const transactionsRouter = Router();

const VALID_TYPES: TransactionType[] = ['expense', 'income', 'transfer', 'excluded'];

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

function parseJsonArray(input: string | null | undefined): number[] {
  if (!input) return [];
  try {
    const arr = JSON.parse(input);
    return Array.isArray(arr) ? arr.filter((n) => Number.isFinite(n)) : [];
  } catch {
    return [];
  }
}

interface TxInput {
  type: TransactionType;
  name: string;
  amount: number;
  date: number;
  categoryId?: number | null;
  accountId: number;
  toAccountId?: number | null;
  remark?: string | null;
  tagIds?: string | null;
  merchantId?: number | null;
  includeInAsset?: number;
  spaceId?: number;
}

/** 按当前 type 把 amount 应用到 account 上（+amount 或 -amount 或 transfer）。 */
function applyDelta(account: AccountRow, delta: number): number {
  return account.balance + delta;
}

/** 计算单笔 tx 对 account 的净影响（用于余额回滚/重算）。 */
function impactOnAccount(tx: TransactionRow, accountId: number): number {
  if (tx.includeInAsset === 0) return 0;
  if (tx.type === 'expense' && tx.accountId === accountId) return -tx.amount;
  if (tx.type === 'income' && tx.accountId === accountId) return tx.amount;
  if (tx.type === 'transfer') {
    if (tx.accountId === accountId) return -tx.amount;
    if (tx.toAccountId === accountId) return tx.amount;
  }
  return 0;
}

function loadAccountOrThrow(id: number): AccountRow {
  const db = getDb();
  const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as
    | AccountRow
    | undefined;
  if (!acc) throw Object.assign(new Error(`账户 ${id} 不存在`), { status: 404 });
  return acc;
}

/** GET /api/transactions?from&to&type&accountId&spaceId */
transactionsRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { from, to, type, accountId, spaceId } = req.query;

  const where: string[] = [];
  const params: unknown[] = [];

  if (from !== undefined) {
    const f = Number(from);
    if (!Number.isFinite(f)) {
      res.status(400).json({ error: 'from 必须是数字时间戳' });
      return;
    }
    where.push('date >= ?');
    params.push(f);
  }
  if (to !== undefined) {
    const t = Number(to);
    if (!Number.isFinite(t)) {
      res.status(400).json({ error: 'to 必须是数字时间戳' });
      return;
    }
    where.push('date <= ?');
    params.push(t);
  }
  if (type !== undefined) {
    const t = String(type) as TransactionType;
    if (!VALID_TYPES.includes(t)) {
      res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
      return;
    }
    where.push('type = ?');
    params.push(t);
  }
  if (accountId !== undefined) {
    const a = Number(accountId);
    if (!Number.isFinite(a)) {
      res.status(400).json({ error: 'accountId 必须是数字' });
      return;
    }
    where.push('(accountId = ? OR toAccountId = ?)');
    params.push(a, a);
  }
  if (spaceId !== undefined) {
    const s = Number(spaceId);
    if (!Number.isFinite(s)) {
      res.status(400).json({ error: 'spaceId 必须是数字' });
      return;
    }
    where.push('spaceId = ?');
    params.push(s);
  }

  const sql = `SELECT * FROM transactions ${
    where.length ? 'WHERE ' + where.join(' AND ') : ''
  } ORDER BY date DESC, id DESC`;
  const rows = db.prepare(sql).all(...params) as TransactionRow[];
  res.json(rows);
});

/** POST /api/transactions */
transactionsRouter.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const body = req.body ?? {};
  const type = String(body.type ?? '') as TransactionType;
  if (!VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
    return;
  }
  const name = String(body.name ?? '').trim();
  if (!name) {
    res.status(400).json({ error: 'name 必填' });
    return;
  }
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: 'amount 必须为正数' });
    return;
  }
  const accountId = Number(body.accountId);
  if (!Number.isFinite(accountId)) {
    res.status(400).json({ error: 'accountId 必填' });
    return;
  }
  let toAccountId: number | null = null;
  if (type === 'transfer') {
    const tid = Number(body.toAccountId);
    if (!Number.isFinite(tid)) {
      res.status(400).json({ error: 'transfer 必须指定 toAccountId' });
      return;
    }
    if (tid === accountId) {
      res.status(400).json({ error: 'toAccountId 不能等于 accountId' });
      return;
    }
    toAccountId = tid;
  }
  const date =
    body.date !== undefined ? Number(body.date) : nowMs();
  if (!Number.isFinite(date)) {
    res.status(400).json({ error: 'date 必须是数字时间戳' });
    return;
  }

  const categoryId = body.categoryId !== undefined ? Number(body.categoryId) : null;
  const remark = body.remark !== undefined ? String(body.remark) : null;
  const tagIds = parseTagIds(body.tagIds) ?? null;
  const merchantId = body.merchantId !== undefined ? Number(body.merchantId) : null;
  const includeInAsset =
    body.includeInAsset === undefined ? 1 : body.includeInAsset ? 1 : 0;
  const spaceId = body.spaceId !== undefined ? Number(body.spaceId) : 1;

  const tx: TxInput = {
    type,
    name,
    amount,
    date,
    categoryId,
    accountId,
    toAccountId,
    remark,
    tagIds,
    merchantId,
    includeInAsset,
    spaceId,
  };

  try {
    const insertedId = db.transaction(() => {
      loadAccountOrThrow(accountId);
      if (toAccountId !== null) loadAccountOrThrow(toAccountId);

      const result = db
        .prepare(
          `INSERT INTO transactions
            (type, name, amount, date, categoryId, accountId, toAccountId, remark, tagIds, merchantId, includeInAsset, spaceId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tx.type,
          tx.name,
          tx.amount,
          tx.date,
          tx.categoryId,
          tx.accountId,
          tx.toAccountId,
          tx.remark,
          tx.tagIds,
          tx.merchantId,
          tx.includeInAsset,
          tx.spaceId,
          nowMs(),
        );

      // 余额联动
      if (tx.includeInAsset) {
        const acc = loadAccountOrThrow(tx.accountId);
        const newBalance = applyDelta(acc, -tx.amount);
        db.prepare('UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?').run(
          newBalance,
          nowMs(),
          tx.accountId,
        );
        if (tx.type === 'transfer' && tx.toAccountId != null) {
          const to = loadAccountOrThrow(tx.toAccountId);
          db.prepare(
            'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
          ).run(applyDelta(to, tx.amount), nowMs(), tx.toAccountId);
        }
      }

      return result.lastInsertRowid;
    })();

    const row = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(insertedId) as TransactionRow;
    res.status(201).json(row);
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/** PUT /api/transactions/:id */
transactionsRouter.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(id) as TransactionRow | undefined;
  if (!existing) {
    res.status(404).json({ error: '交易不存在' });
    return;
  }

  const body = req.body ?? {};
  const updates: string[] = [];
  const params: unknown[] = [];

  const setField = (col: string, val: unknown) => {
    updates.push(`${col} = ?`);
    params.push(val);
  };

  let newType: TransactionType = existing.type;
  if (body.type !== undefined) {
    const t = String(body.type) as TransactionType;
    if (!VALID_TYPES.includes(t)) {
      res.status(400).json({ error: `type 必须是 ${VALID_TYPES.join('/')}` });
      return;
    }
    newType = t;
    setField('type', t);
  }
  if (body.name !== undefined) setField('name', String(body.name));
  if (body.amount !== undefined) {
    const a = Number(body.amount);
    if (!Number.isFinite(a) || a <= 0) {
      res.status(400).json({ error: 'amount 必须为正数' });
      return;
    }
    setField('amount', a);
  }
  if (body.date !== undefined) {
    const d = Number(body.date);
    if (!Number.isFinite(d)) {
      res.status(400).json({ error: 'date 必须是数字时间戳' });
      return;
    }
    setField('date', d);
  }
  if (body.categoryId !== undefined) setField('categoryId', Number(body.categoryId));
  if (body.accountId !== undefined) {
    const a = Number(body.accountId);
    if (!Number.isFinite(a)) {
      res.status(400).json({ error: 'accountId 必须是数字' });
      return;
    }
    setField('accountId', a);
  }
  if (body.toAccountId !== undefined) {
    const a = Number(body.toAccountId);
    setField('toAccountId', Number.isFinite(a) ? a : null);
  }
  if (body.remark !== undefined)
    setField('remark', body.remark === null ? null : String(body.remark));
  if (body.tagIds !== undefined) setField('tagIds', parseTagIds(body.tagIds) ?? null);
  if (body.merchantId !== undefined) setField('merchantId', Number(body.merchantId));
  if (body.includeInAsset !== undefined)
    setField('includeInAsset', body.includeInAsset ? 1 : 0);
  if (body.spaceId !== undefined) setField('spaceId', Number(body.spaceId));

  try {
    db.transaction(() => {
      // 1. 回滚旧值
      const oldImpactA = impactOnAccount(existing, existing.accountId);
      if (oldImpactA !== 0) {
        const acc = loadAccountOrThrow(existing.accountId);
        db.prepare(
          'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
        ).run(acc.balance - oldImpactA, nowMs(), existing.accountId);
      }
      if (existing.type === 'transfer' && existing.toAccountId != null) {
        const oldImpactT = impactOnAccount(existing, existing.toAccountId);
        if (oldImpactT !== 0) {
          const acc = loadAccountOrThrow(existing.toAccountId);
          db.prepare(
            'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
          ).run(acc.balance - oldImpactT, nowMs(), existing.toAccountId);
        }
      }

      // 2. 应用新值
      if (updates.length === 0) return;
      params.push(id);
      db.prepare(`UPDATE transactions SET ${updates.join(', ')} WHERE id = ?`).run(
        ...params,
      );
      const fresh = db
        .prepare('SELECT * FROM transactions WHERE id = ?')
        .get(id) as TransactionRow;

      if (fresh.includeInAsset) {
        const acc = loadAccountOrThrow(fresh.accountId);
        const delta = impactOnAccount(fresh, fresh.accountId);
        if (delta !== 0) {
          db.prepare(
            'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
          ).run(acc.balance + delta, nowMs(), fresh.accountId);
        }
        if (fresh.type === 'transfer' && fresh.toAccountId != null) {
          const tacc = loadAccountOrThrow(fresh.toAccountId);
          const tdelta = impactOnAccount(fresh, fresh.toAccountId);
          if (tdelta !== 0) {
            db.prepare(
              'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
            ).run(tacc.balance + tdelta, nowMs(), fresh.toAccountId);
          }
        }
      }
    })();

    const row = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(id) as TransactionRow;
    res.json(row);
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

/** DELETE /api/transactions/:id */
transactionsRouter.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: 'id 必须是数字' });
    return;
  }
  const existing = db
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(id) as TransactionRow | undefined;
  if (!existing) {
    res.status(404).json({ error: '交易不存在' });
    return;
  }

  try {
    db.transaction(() => {
      // 回滚余额
      if (existing.includeInAsset) {
        const impactA = impactOnAccount(existing, existing.accountId);
        if (impactA !== 0) {
          const acc = loadAccountOrThrow(existing.accountId);
          db.prepare(
            'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
          ).run(acc.balance - impactA, nowMs(), existing.accountId);
        }
        if (existing.type === 'transfer' && existing.toAccountId != null) {
          const impactT = impactOnAccount(existing, existing.toAccountId);
          if (impactT !== 0) {
            const acc = loadAccountOrThrow(existing.toAccountId);
            db.prepare(
              'UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?',
            ).run(acc.balance - impactT, nowMs(), existing.toAccountId);
          }
        }
      }
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    })();
    res.status(204).end();
  } catch (err) {
    const status =
      err && typeof err === 'object' && 'status' in err ? (err as { status: number }).status : 500;
    res.status(status).json({ error: (err as Error).message });
  }
});

// ── helpers used by summary route / tests ──
export const txHelpers = {
  parseTagIds,
  parseJsonArray,
  impactOnAccount,
};
