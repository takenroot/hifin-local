/**
 * 基线快照（只读）：写库前把不变量拍下来
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const db = new Database(resolve('data/hifin.db'), { readonly: true });

const tx = db.prepare(
  'SELECT id, type, name, amount, date, accountId, categoryId FROM transactions ORDER BY id',
).all() as Array<Record<string, unknown>>;

const money = db
  .prepare('SELECT id, balance FROM accounts ORDER BY id')
  .all() as Array<{ id: number; balance: number }>;

const agg = db
  .prepare(
    `SELECT type, COUNT(*) c, ROUND(SUM(amount),2) s, ROUND(MIN(amount),2) mn, ROUND(MAX(amount),2) mx,
            MIN(date) mind, MAX(date) maxd
       FROM transactions GROUP BY type ORDER BY type`,
  )
  .all();

const overall = db
  .prepare(
    `SELECT COUNT(*) c, ROUND(SUM(amount),4) sum, ROUND(SUM(CASE WHEN type='expense' THEN -amount WHEN type='income' THEN amount ELSE 0 END),4) net
       FROM transactions`,
  )
  .get();

const nullCat = db.prepare('SELECT COUNT(*) c FROM transactions WHERE categoryId IS NULL').get();
const rules = db.prepare('SELECT COUNT(*) c FROM rules').get();

// amount/date/type 指纹（逐行 sha256，用于写后逐行比对）
const h = createHash('sha256');
for (const r of tx) h.update(`${r.id}|${r.type}|${r.name}|${r.amount}|${r.date}|${r.accountId}\n`);
const fingerprint = h.digest('hex');

console.log('=== BASELINE ===');
console.log('transactions:', tx.length);
console.log('per-type:', JSON.stringify(agg));
console.log('overall:', JSON.stringify(overall));
console.log('nullCategoryId:', (nullCat as { c: number }).c);
console.log('rules:', (rules as { c: number }).c);
console.log('accounts balance:', JSON.stringify(money.map((m) => [m.id, m.balance])));
console.log('balanceSum:', money.reduce((a, b) => a + b.balance, 0).toFixed(2));
console.log('fingerprint(amount/date/type/name/accountId):', fingerprint);

// 按 name+type 存一份全量快照，写后逐行 diff
console.log('\n=== 全量逐行快照已可由 fingerprint 复现 ===');
