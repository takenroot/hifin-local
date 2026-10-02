/**
 * 一次性脚本：把商户分类映射落进 rules 表 + 回填存量 transactions.categoryId
 * -----------------------------------------------------------------
 * 口径（与调度方约定一致）：
 *   决策顺序   rules 引擎 > 账单分类映射 > null
 *   落库方向   rules 表**没有方向列**（schema.ts 的 RuleRow 只有
 *              keyword/matchField/categoryId/priority/enabled/createdAt），
 *              所以按调度方指示：同名多方向时**支出方向进 rules**，
 *              收入方向只走存量回填、不进 rules。
 *   映射方向   映射 JSON 本身没有 type 列，用 categories.type 作为该条目的方向
 *              （与 bill/category-map.ts 的 BILL_CATEGORY_TYPES 闸门口径一致）：
 *              支出分类只作用于 type='expense'，收入分类只作用于 type='income'。
 *
 * 约束       **不要写入单字符 keyword**（长度 < 2）。匹配是 includes 子串匹配，
 *              单字符规则的误伤面几乎等于全部商户名——上一轮 226 条里就混进了
 *              keyword="平"（→人情往来）和 "💫"（→其他收入），实测分别抢走了
 *              "拼多多平台商户"和"刘燕大号 (💫)"的分类。已在库里的那两条由
 *              scripts/disable-short-rules.ts 停用（enabled=0）；这里从源头挡住，
 *              免得下次再生成一批。判据必须用 SQL 的 length()（按码点）而不是
 *              JS 的 keyword.length（按 UTF-16 码元），否则 "💫" 会被当成 2 字符漏掉。
 *
 * 刻意只写 categoryId / rules 两处，绝不碰 amount / date / type / balance。
 *
 * 用法：
 *   npx tsx scripts/apply-merchant-rules.ts            # dry-run
 *   npx tsx scripts/apply-merchant-rules.ts --apply
 *   npx tsx scripts/apply-merchant-rules.ts --map <path>
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const mapArg = argv.indexOf('--map');
const MAP_PATH = mapArg >= 0 ? argv[mapArg + 1] : '/tmp/merchant-classification.work.json';
const DB_PATH = resolve('data/hifin.db');

interface Entry {
  merchant: string;
  category: string;
  confidence: string;
  reason: string;
}

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 10000');   // :8787 的 REST 服务可能同时在读
const map = JSON.parse(readFileSync(MAP_PATH, 'utf8')) as { mappings: Entry[] };

const cats = db.prepare('SELECT id,name,type FROM categories').all() as Array<{
  id: number; name: string; type: string;
}>;
const catByName = new Map(cats.map((c) => [c.name, c]));

// ── 1. 规则方向：支出进 rules；同名多方向时收入方向跳过 ──────────────
const namesWithBoth = new Set<string>();
{
  const byName = new Map<string, Set<string>>();
  for (const m of map.mappings) {
    if (!m.category) continue;
    const c = catByName.get(m.category);
    if (!c) throw new Error(`分类名在 categories 表中不存在: ${m.category}`);
    const s = byName.get(m.merchant) ?? new Set<string>();
    s.add(c.type);
    byName.set(m.merchant, s);
  }
  for (const [n, s] of byName) if (s.size > 1) namesWithBoth.add(n);
}

interface RulePlan {
  keyword: string; category: string; categoryId: number; type: string;
}
const rulePlans: RulePlan[] = [];
const incomeOnlySkipped: Array<{ merchant: string; category: string; categoryId: number }> = [];
const noCategory: Entry[] = [];
const seen = new Set<string>();

for (const m of map.mappings) {
  if (!m.category) { noCategory.push(m); continue; }
  const c = catByName.get(m.category)!;
  if (namesWithBoth.has(m.merchant) && c.type === 'income') {
    incomeOnlySkipped.push({ merchant: m.merchant, category: m.category, categoryId: c.id });
    continue;
  }
  const key = `${m.merchant}\u0000${c.type}`;
  if (seen.has(key)) continue;   // 防御：同名同方向重复条目只落一条
  seen.add(key);
  rulePlans.push({ keyword: m.merchant, category: m.category, categoryId: c.id, type: c.type });
}

// ── 2. 回填计划：name + 方向双条件命中 ──────────────────────────────
const dirIdx = new Map<string, { id: number; cat: string }>();
for (const m of map.mappings) {
  if (!m.category) continue;
  const c = catByName.get(m.category)!;
  dirIdx.set(`${m.merchant}\u0000${c.type}`, { id: c.id, cat: m.category });
}
const unclassified = db
  .prepare('SELECT id, type, name FROM transactions WHERE categoryId IS NULL ORDER BY id')
  .all() as Array<{ id: number; type: string; name: string }>;
const fills: Array<{ id: number; categoryId: number; category: string; type: string }> = [];
const skipped: Array<{ name: string; type: string }> = [];
for (const r of unclassified) {
  const hit = dirIdx.get(`${r.name}\u0000${r.type}`);
  if (hit === undefined) skipped.push(r);
  else fills.push({ id: r.id, categoryId: hit.id, category: hit.cat, type: r.type });
}

// ── 3. 报告（dry-run 与 apply 同一份计划）──────────────────────────
console.log('=== 映射副本 ===', MAP_PATH);
console.log('条目总数:', map.mappings.length,
  '| 非空分类:', map.mappings.length - noCategory.length,
  '| 空分类:', noCategory.length);
console.log('同名多方向商户:', namesWithBoth.size);
console.log('\n=== 计划写入 rules ===', rulePlans.length, '条');
console.log('  keyword=商户全名 / matchField=\'name\' / priority=10 / enabled=1');
const byType: Record<string, number> = {};
for (const r of rulePlans) byType[r.type] = (byType[r.type] ?? 0) + 1;
console.log('  按分类方向:', byType);
console.log('  收入方向不进 rules（只回填）:', incomeOnlySkipped.length, '条');
incomeOnlySkipped.forEach((s) => console.log('    -', s.merchant, '->', s.category, `#${s.categoryId}`));
console.log('\n=== 计划回填 transactions.categoryId ===', fills.length, '笔');
const fillByType: Record<string, number> = {};
for (const f of fills) fillByType[f.type] = (fillByType[f.type] ?? 0) + 1;
console.log('  按流水方向:', fillByType);
const fillByCat: Record<string, number> = {};
for (const f of fills) fillByCat[f.category] = (fillByCat[f.category] ?? 0) + 1;
console.log('  按分类:');
Object.entries(fillByCat).sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log('   ', k, v));
console.log('  回填后残留未分类:', skipped.length, `(${(skipped.length / unclassified.length * 100).toFixed(1)}%)`);
skipped.forEach((s) => console.log('    -', JSON.stringify(s.name), s.type));

if (!APPLY) {
  console.log('\n[dry-run] 未写库。加 --apply 真正执行。');
  process.exit(0);
}

// ── 4. 幂等守卫 ─────────────────────────────────────────────────────
const rulesBefore = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
if (rulesBefore > 0) throw new Error(`rules 表已有 ${rulesBefore} 行，拒绝重复执行（避免重复落库）`);

// ── 5. 写库（单事务）────────────────────────────────────────────────
// 写进来的每条 keyword 都已过一道长度自检（见文件头「约束」段）：
// 单字符 keyword 在 includes 语义下会误伤任意包含它的商户名，宁可少一条规则。
const tooShort = rulePlans.filter((r) => [...r.keyword].length < 2);
if (tooShort.length > 0) {
  throw new Error(
    `拒绝写入 ${tooShort.length} 条单字符规则（includes 语义下误伤面过大）: ` +
      tooShort.map((r) => JSON.stringify(r.keyword)).join(', '),
  );
}
const insertRule = db.prepare(
  `INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt)
   VALUES (?, 'name', ?, 10, 1, ?)`,
);
const updTx = db.prepare(
  'UPDATE transactions SET categoryId = ? WHERE id = ? AND categoryId IS NULL',
);
const base = Date.now();
const run = db.transaction(() => {
  rulePlans.forEach((r, i) => insertRule.run(r.keyword, r.categoryId, base + i));
  for (const f of fills) updTx.run(f.categoryId, f.id);
});
run();

const rulesAfter = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
const nullAfter = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE categoryId IS NULL').get() as { c: number }).c;
console.log('\n=== 已执行 ===');
console.log('rules:', rulesBefore, '->', rulesAfter);
console.log('nullCategoryId:', unclassified.length, '->', nullAfter);
db.close();
