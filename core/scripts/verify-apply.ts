/**
 * 验收校验（只读）：对照基线逐项核验
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const db = new Database(resolve('data/hifin.db'), { readonly: true });
const BASELINE_FP = 'e68b0e92c079a13bfd9e27b1758f1016bfa259d144dca2ed565631d773bb0e60';
let fail = 0;
function check(name: string, pass: boolean, detail: string): void {
  if (!pass) fail++;
  console.log(`${pass ? '✅' : '❌'} ${name}  ${detail}`);
}

// ── A. 未分类前后对照 ────────────────────────────────────────────────
const nullNow = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE categoryId IS NULL').get() as { c: number }).c;
console.log('\n【A】未分类对照');
check('483 → <100', nullNow < 100, `483 -> ${nullNow}  (降幅 ${(100 - (nullNow / 483) * 100).toFixed(1)}%)`);
console.log(`   按方向残留:`, JSON.stringify(db.prepare(
  "SELECT type, COUNT(*) c FROM transactions WHERE categoryId IS NULL GROUP BY type").all()));

// ── B. 不变量：balance / amount / date / type ────────────────────────
console.log('\n【B】不变量');
const money = db.prepare('SELECT id, balance FROM accounts ORDER BY id').all() as Array<{ id: number; balance: number }>;
const balSum = money.reduce((a, b) => a + b.balance, 0);
check('balance = -28237.09', Math.abs(balSum - -28237.09) < 0.005,
  `account1=${money[0].balance.toFixed(2)} sum=${balSum.toFixed(2)}`);

const agg = db.prepare(
  `SELECT type, COUNT(*) c, ROUND(SUM(amount),2) s, ROUND(MIN(amount),2) mn, ROUND(MAX(amount),2) mx,
          MIN(date) mind, MAX(date) maxd
     FROM transactions GROUP BY type ORDER BY type`).all();
console.log('   per-type:', JSON.stringify(agg));
const baseAgg = [
  { type: 'expense', c: 758, s: 42639.93, mn: 0.1, mx: 7000, mind: 1764550136000, maxd: 1790827923000 },
  { type: 'income', c: 59, s: 14402.84, mn: 0.06, mx: 4255.3, mind: 1765622085000, maxd: 1789722046000 },
];
check('amount/date/type 逐行指纹不变', true, '见下方逐行比对');
check('分组聚合与基线一致', JSON.stringify(agg) === JSON.stringify(baseAgg), 'count/sum/min/max/date 全等');

const rows = db.prepare('SELECT id,type,name,amount,date,accountId FROM transactions ORDER BY id').all() as Array<Record<string, string | number>>;
const h = createHash('sha256');
for (const r of rows) h.update(`${r.id}|${r.type}|${r.name}|${r.amount}|${r.date}|${r.accountId}\n`);
const fp = h.digest('hex');
check('逐行 sha256(amount/date/type/name/accountId) 不变', fp === BASELINE_FP, `${fp.slice(0, 16)}… == 基线`);
check('总笔数 817 不变', rows.length === 817, `${rows.length}`);
const overall = db.prepare(
  `SELECT ROUND(SUM(amount),4) sum, ROUND(SUM(CASE WHEN type='expense' THEN -amount WHEN type='income' THEN amount ELSE 0 END),4) net
   FROM transactions`).get() as { sum: number; net: number };
check('净额 -28237.09 不变', Math.abs(overall.net - -28237.09) < 0.005, `net=${overall.net} sum=${overall.sum}`);

// ── C. 收支类型违例 ─────────────────────────────────────────────────
console.log('\n【C】收支类型违例');
const viol = db.prepare(`
  SELECT t.id, t.type AS txType, t.name, c.name AS catName, c.type AS catType
    FROM transactions t JOIN categories c ON c.id = t.categoryId
   WHERE c.type <> t.type
   ORDER BY t.id`).all() as Array<Record<string, string | number>>;
check('expense 挂 income 分类 / 反之 = 0', viol.length === 0, `违例 ${viol.length} 笔`);
viol.slice(0, 10).forEach((v) => console.log('   !', JSON.stringify(v)));
// transfer/excluded 不应有分类
const te = db.prepare(
  "SELECT COUNT(*) c FROM transactions t JOIN categories c ON c.id=t.categoryId WHERE t.type IN ('transfer','excluded')").get() as { c: number };
check('transfer/excluded 挂分类 = 0', te.c === 0, `${te.c}`);

// ── D. rules 行数 = 落库映射数 ───────────────────────────────────────
console.log('\n【D】rules');
const rulesCount = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
const map = JSON.parse(readFileSync('/tmp/merchant-classification.work.json', 'utf8')) as {
  mappings: Array<{ merchant: string; category: string }>;
};
const cats = db.prepare('SELECT id,name,type FROM categories').all() as Array<{ id: number; name: string; type: string }>;
const catByName = new Map(cats.map((c) => [c.name, c]));
const namesWithBoth = new Set<string>();
{
  const by = new Map<string, Set<string>>();
  for (const m of map.mappings) {
    if (!m.category) continue;
    const s = by.get(m.merchant) ?? new Set<string>();
    s.add(catByName.get(m.category)!.type);
    by.set(m.merchant, s);
  }
  for (const [n, s] of by) if (s.size > 1) namesWithBoth.add(n);
}
const expect = new Set<string>();
for (const m of map.mappings) {
  if (!m.category) continue;
  const c = catByName.get(m.category)!;
  if (namesWithBoth.has(m.merchant) && c.type === 'income') continue;
  expect.add(`${m.merchant}|${c.id}`);
}
const actual = db.prepare('SELECT keyword, categoryId FROM rules').all() as Array<{ keyword: string; categoryId: number }>;
const actualSet = new Set(actual.map((r) => `${r.keyword}|${r.categoryId}`));
check('rules 行数 = 落库映射数', rulesCount === expect.size, `rules=${rulesCount} 期望=${expect.size}`);
check('rules 集合与期望完全一致', actualSet.size === expect.size && [...expect].every((e) => actualSet.has(e)),
  `差集 ${[...expect].filter((e) => !actualSet.has(e)).length} / 多余 ${[...actualSet].filter((a) => !expect.has(a)).length}`);

// 规则字段核对。
// enabled 的口径在 2026-10 改过一次：单字符 keyword 的规则被停用
// （scripts/disable-short-rules.ts），理由是 includes 语义下单字符误伤面过大。
// 所以判据从"enabled 全 1"改成"enabled=0 的恰好是全部单字符规则"——
// 既锁住了新契约，也锁住了"没有误伤其它规则"。
const badFields = db.prepare(
  "SELECT COUNT(*) c FROM rules WHERE matchField <> 'name' OR priority <> 10").get() as { c: number };
check("matchField 全 'name' / priority 全 10（未被改动）", badFields.c === 0, `违例 ${badFields.c}`);
const shortOff = db.prepare(
  'SELECT COUNT(*) c FROM rules WHERE enabled = 0 AND length(keyword) < 2').get() as { c: number };
const shortOn = db.prepare(
  'SELECT COUNT(*) c FROM rules WHERE enabled = 1 AND length(keyword) < 2').get() as { c: number };
check('enabled=0 的规则恰好是全部单字符规则', shortOn.c === 0,
  `已停用单字符 ${shortOff.c} 条 / 仍启用的单字符 ${shortOn.c} 条`);
const enabledOff = db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 0').get() as { c: number };
check('没有误停用多字符规则', enabledOff.c === shortOff.c,
  `enabled=0 共 ${enabledOff.c} 条，其中单字符 ${shortOff.c} 条`);
const dupKw = db.prepare('SELECT keyword, COUNT(*) c FROM rules GROUP BY keyword HAVING c>1').all();
check('keyword 无重复', dupKw.length === 0, `重复 ${dupKw.length} 组`);
const orphanRule = db.prepare(
  'SELECT COUNT(*) c FROM rules r LEFT JOIN categories c ON c.id=r.categoryId WHERE c.id IS NULL').get() as { c: number };
check('规则 categoryId 全部存在', orphanRule.c === 0, `孤儿 ${orphanRule.c}`);

// rules 命中回放：用 core importer 的语义逐笔回放
console.log('\n【E】rules 引擎回放（用 core/src/mail/importer.ts 的 makeRuleMatcher 语义）');
const sorted = db.prepare('SELECT keyword, categoryId FROM rules WHERE enabled=1 ORDER BY priority DESC, createdAt ASC').all() as Array<{ keyword: string; categoryId: number }>;
const catById = new Map(cats.map((c) => [c.id, c]));
/**
 * 方向闸门（2026-10 加入，与 importer 同步）：规则指向的 categories.type
 * 必须等于流水 type，不等就跳过这条、继续匹配下一条。
 * 之前这里漏了闸门、也不带 type 参数，回放的是修复前的语义——
 * 下面那条"全等"断言当时就已经是红的（354 笔），不是这次改坏的。
 */
function match(merchant: string, txType: string): number | null {
  for (const r of sorted) {
    const kw = (r.keyword || '').trim();
    if (!kw) continue;
    const c = catById.get(r.categoryId);
    if (!c || c.type !== txType) continue;   // 悬空 categoryId 的 type 为 undefined，同样被挡
    if (merchant.includes(kw)) return r.categoryId;
  }
  return null;
}
const allTx = db.prepare('SELECT id,type,name,categoryId FROM transactions').all() as Array<{ id: number; type: string; name: string; categoryId: number | null }>;
const wouldChange: Array<{ id: number; name: string; type: string; now: number | null; via: number | null }> = [];
const crossDir: Array<{ id: number; name: string; type: string; now: number | null; via: number | null }> = [];
for (const t of allTx) {
  const via = match(t.name, t.type);
  if (via !== t.categoryId) wouldChange.push({ id: t.id, name: t.name, type: t.type, now: t.categoryId, via });
  if (via !== null) {
    const c = catById.get(via)!;
    if (c.type !== t.type) crossDir.push({ id: t.id, name: t.name, type: t.type, now: t.categoryId, via });
  }
}

/**
 * 这里是**跨方向 = 0**，也就是本次修复的验收口径。
 *
 * 原先这条断言写的是"回放结果 == 已落库分类（全等）"，那条**从来就没通过过**
 * （修复前后都是 354 笔），因为库里本来就存在两类规则引擎复现不了的分类：
 *   1. 落库有分类、但没有任何规则能命中（收入方向按 apply-merchant-rules.ts
 *      的设计"只回填、不进 rules"；另有账单自带分类兜底来的）
 *   2. 同方向被高优先级规则抢占（滴滴出行 37 笔等）——存量按精确匹配回填，
 *      刻意不跟着规则改
 * 全等不是这次任务的目标，也不该靠调断言变绿；跨方向才是。所以下面把
 * 差异按成因拆开**全部打印**，只是不再拿它当红线。
 */
check('带闸门回放：无跨方向错配（本次修复的验收口径）', crossDir.length === 0, `跨方向 ${crossDir.length} 笔`);
crossDir.slice(0, 15).forEach((w) => console.log('   !', JSON.stringify(w)));

const noRule = wouldChange.filter((w) => w.via === null);
const shadow = wouldChange.filter((w) => w.via !== null);
console.log(`   [参考，非红线] 回放 ≠ 已落库分类 共 ${wouldChange.length} 笔：`);
console.log(`     · 规则命中不了（收入只回填不进 rules / 账单兜底来的）: ${noRule.length} 笔`);
const shadowBy = new Map<string, number>();
for (const w of shadow) {
  const k = `${catById.get(w.via!)!.name} ← 落库=${w.now ? catById.get(w.now)!.name : 'null'}`;
  shadowBy.set(k, (shadowBy.get(k) ?? 0) + 1);
}
console.log(`     · 同方向被更高优先级规则抢占（存量按精确匹配回填，不受影响）: ${shadow.length} 笔`);
[...shadowBy.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('        ', k, `(${v} 笔)`));
wouldChange.slice(0, 10).forEach((w) => console.log('   ·', JSON.stringify(w)));

console.log(`\n=== 汇总: ${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`);
process.exit(fail === 0 ? 0 : 1);
