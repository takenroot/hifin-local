/**
 * /api/accounts 路由 — 账户 CRUD + 年收益率
 * - GET    列表，可按 spaceId 过滤；每行附带 latestYield（最近一年的收益率）
 * - POST   创建
 * - PUT    更新（name / type / balance / remark / tagIds / includeInNetAsset / spaceId）
 * - DELETE 删除
 * - GET    /:id/yields        该账户的年收益率历史（按年份倒序）
 * - PUT    /:id/yields/:year  按年 upsert（补填即自动解决催填通知）
 *
 * 复用 src/db 模块的 getDb() 获取 better-sqlite3 实例。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { AccountRow, AccountType } from '../db/schema.js';
import { resolveYieldReminders } from '../yields/reminder.js';

export const accountsRouter = Router();

const VALID_TYPES: AccountType[] = [
  'fund', 'asset', 'social', 'invest', 'other', 'credit', 'debt',
];

/** latestYield 在 JSON 里的形状（契约固定为 { year, yieldPercent } | null） */
interface LatestYield {
  year: number;
  yieldPercent: number;
}

/** 年份的合理区间：防止 "20250" / "-1" 这类脏值把库里写花 */
const MIN_YEAR = 1970;
const MAX_YEAR = 2999;

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

/**
 * 账户行 + latestYield 的查询。
 *
 * 用 LEFT JOIN 而不是先查账户再补一次：latestYield 取的是"年份最大"的那条，
 * 相关子查询 (ORDER BY year DESC LIMIT 1) 走 UNIQUE(accountId, year) 自带的索引，
 * 账户条数是几十级别，多一次查询纯属浪费。
 *
 * 两个辅助列 latestYieldYear / latestYieldPercent 只存在于结果集里，
 * 映射成 latestYield 对象后会删掉，不会漏进 JSON。
 */
function selectAccounts(where: string, params: unknown[]): Array<Record<string, unknown>> {
  return getDb()
    .prepare(
      `SELECT a.*,
              y.year AS latestYieldYear,
              y.yieldPercent AS latestYieldPercent
         FROM accounts a
         LEFT JOIN accountYields y
                ON y.id = (SELECT id FROM accountYields
                            WHERE accountId = a.id
                            ORDER BY year DESC LIMIT 1)
        ${where}
        ORDER BY a.id ASC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}

/** 结果集 → 账户 JSON：附加 latestYield，剥掉两个辅助列 */
function withLatestYield(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => {
    const { latestYieldYear, latestYieldPercent, ...account } = row;
    const latestYield: LatestYield | null =
      typeof latestYieldYear === 'number' && typeof latestYieldPercent === 'number'
        ? { year: latestYieldYear, yieldPercent: latestYieldPercent }
        : null;
    return { ...account, latestYield };
  });
}

/** GET /api/accounts?spaceId=N */
accountsRouter.get('/', (req: Request, res: Response) => {
  const spaceId = req.query.spaceId;
  let rows: Array<Record<string, unknown>>;
  if (spaceId !== undefined) {
    const sid = Number(spaceId);
    if (!Number.isFinite(sid)) {
      res.status(400).json({ error: 'spaceId 必须是数字' });
      return;
    }
    rows = selectAccounts('WHERE a.spaceId = ?', [sid]);
  } else {
    rows = selectAccounts('', []);
  }
  res.json(withLatestYield(rows));
});

/** GET /api/accounts/:id/yields → [{ year, yieldPercent, note }]，按年份倒序 */
accountsRouter.get('/:id/yields', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
  if (!account) {
    res.status(404).json({ error: '账户不存在' });
    return;
  }
  const rows = db
    .prepare(
      `SELECT year, yieldPercent, note
         FROM accountYields
        WHERE accountId = ?
        ORDER BY year DESC`,
    )
    .all(id) as Array<{ year: number; yieldPercent: number; note: string | null }>;
  res.json(rows);
});

/**
 * PUT /api/accounts/:id/yields/:year — upsert 某年收益率。
 * body: { yieldPercent, note? }
 *
 * 落库用 ON CONFLICT(accountId, year) DO UPDATE：UNIQUE 约束是幂等的唯一依据，
 * 同一年的第二次提交是"改数字"而不是"多一条"。
 * 写成功后顺手解决该年的催填通知（resolveYieldReminders 内部已做去重）。
 */
accountsRouter.put('/:id/yields/:year', (req: Request, res: Response) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: 'id 必须是正整数' });
    return;
  }
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    res.status(400).json({ error: `year 必须是 ${MIN_YEAR}~${MAX_YEAR} 的整数` });
    return;
  }
  const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(id);
  if (!account) {
    res.status(404).json({ error: '账户不存在' });
    return;
  }

  const body = req.body ?? {};
  if (body.yieldPercent === undefined || body.yieldPercent === null || body.yieldPercent === '') {
    res.status(400).json({ error: 'yieldPercent 必填' });
    return;
  }
  const yieldPercent = Number(body.yieldPercent);
  if (!Number.isFinite(yieldPercent)) {
    res.status(400).json({ error: 'yieldPercent 必须是数字' });
    return;
  }
  if (yieldPercent < -100 || yieldPercent > 100) {
    res.status(400).json({ error: 'yieldPercent 须在 -100 到 100 之间' });
    return;
  }
  const note =
    body.note === undefined || body.note === null ? null : String(body.note).trim() || null;

  db.prepare(
    `INSERT INTO accountYields (accountId, year, yieldPercent, note, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(accountId, year) DO UPDATE SET
       yieldPercent = excluded.yieldPercent,
       note = excluded.note`,
  ).run(id, year, yieldPercent, note, nowMs());

  // 补填即消提醒：这条不变量放在 yields/reminder.ts 里，路由只管调用
  resolveYieldReminders(db, id, year);

  const row = db
    .prepare('SELECT year, yieldPercent, note FROM accountYields WHERE accountId = ? AND year = ?')
    .get(id, year) as { year: number; yieldPercent: number; note: string | null };
  res.json(row);
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
