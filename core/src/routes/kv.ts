/**
 * /api/kv/:key 路由 — 简单键值存储
 * - GET    /api/kv/:key  读取并反序列化 value
 * - PUT    /api/kv/:key  写入（upsert），value 为任意 JSON
 * - DELETE /api/kv/:key  删除
 *
 * 存的是 kv(key TEXT PRIMARY KEY, value TEXT JSON)，
 * 对外 value 始终是反序列化后的 JSON 值，调用方不需要自己 parse。
 *
 * PUT 入参兼容两种写法：
 *   { "value": <任意 JSON> }  —— 推荐
 *   <任意 JSON 本体>          —— body 里没有 value 字段时，整个 body 即 value
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { KvRow } from '../db/schema.js';

export const kvRouter = Router();

/** key 形如 lastSyncAt / ui.theme，空 key 无意义。 */
function parseKey(raw: string): string {
  return decodeURIComponent(raw).trim();
}

/** 存储的 JSON 文本 → 对外的 JSON 值。 */
function parseValue(raw: string | undefined): unknown {
  if (raw === undefined || raw === null || raw === '') return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 脏数据原样返回，不让读取失败
    return raw;
  }
}

/** kv 行 → 对外响应。 */
function toResponse(row: KvRow): { key: string; value: unknown } {
  return { key: row.key, value: parseValue(row.value) };
}

/** GET /api/kv/:key */
kvRouter.get('/:key', (req: Request, res: Response) => {
  const db = getDb();
  const key = parseKey(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'key 不能为空' });
    return;
  }
  const row = db.prepare('SELECT * FROM kv WHERE key = ?').get(key) as KvRow | undefined;
  if (row === undefined) {
    res.status(404).json({ error: `键不存在: ${key}` });
    return;
  }
  res.json(toResponse(row));
});

/** PUT /api/kv/:key */
kvRouter.put('/:key', (req: Request, res: Response) => {
  const db = getDb();
  const key = parseKey(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'key 不能为空' });
    return;
  }
  const body = req.body ?? {};
  // 兼容 { value: X } 与裸 body 两种写法
  const raw =
    body !== null && typeof body === 'object' && !Array.isArray(body) && 'value' in body
      ? (body as { value: unknown }).value
      : body;

  let stored: string;
  try {
    stored = JSON.stringify(raw === undefined ? null : raw);
  } catch {
    res.status(400).json({ error: 'value 必须是可序列化的 JSON' });
    return;
  }

  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, stored);

  const row = db.prepare('SELECT * FROM kv WHERE key = ?').get(key) as KvRow;
  res.json(toResponse(row));
});

/** DELETE /api/kv/:key */
kvRouter.delete('/:key', (req: Request, res: Response) => {
  const db = getDb();
  const key = parseKey(req.params.key);
  if (!key) {
    res.status(400).json({ error: 'key 不能为空' });
    return;
  }
  const result = db.prepare('DELETE FROM kv WHERE key = ?').run(key);
  if (result.changes === 0) {
    res.status(404).json({ error: `键不存在: ${key}` });
    return;
  }
  res.status(204).end();
});
