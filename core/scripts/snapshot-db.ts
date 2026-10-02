/**
 * 验收用的独立快照：回填前后各跑一次，比对"不该变的字段"。
 * 刻意不复用 backfill-categories.ts 里的取数代码，免得脚本自己有 bug 时
 * 两边一起错、快照对不上却看不出来。
 */
import Database from 'better-sqlite3';

const dbPath = process.argv[2];
const label = process.argv[3] ?? 'SNAPSHOT';
const db = new Database(dbPath, { readonly: true });

const t = db
  .prepare(
    `SELECT COUNT(*) AS txCount,
            SUM(categoryId IS NULL) AS nullCount,
            ROUND(SUM(amount), 2) AS amountSum,
            MIN(date) AS dateMin,
            MAX(date) AS dateMax
       FROM transactions`,
  )
  .get();
const types = db.prepare('SELECT type, COUNT(*) c FROM transactions GROUP BY type ORDER BY type').all();
const accs = db.prepare('SELECT id, name, ROUND(balance, 2) balance FROM accounts ORDER BY id').all();
const cats = db
  .prepare(
    `SELECT c.name, COUNT(*) n FROM transactions t JOIN categories c ON c.id = t.categoryId
      GROUP BY c.id ORDER BY n DESC, c.id`,
  )
  .all();

console.log(`# ${label}`);
console.log(`txCount=${t.txCount} nullCategoryId=${t.nullCount} amountSum=${t.amountSum} dateMin=${t.dateMin} dateMax=${t.dateMax}`);
console.log(`types=${types.map((r) => `${r.type}:${r.c}`).join(',')}`);
for (const a of accs) console.log(`account id=${a.id} name=${a.name} balance=${a.balance}`);
console.log(`classifiedByCategory(${cats.length})=${cats.map((r) => `${r.name}:${r.n}`).join(',')}`);
db.close();
