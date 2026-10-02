/**
 * 只读分析：映射副本 vs 库内交易的方向(type)覆盖情况
 * 不写库，只报告。
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DB = resolve('data/hifin.db');
const MAP = process.argv[2] ?? '/tmp/merchant-classification.work.json';

const db = new Database(DB, { readonly: true });
const map = JSON.parse(readFileSync(MAP, 'utf8')) as {
  mappings: Array<{ merchant: string; category: string; confidence: string; reason: string }>;
};

const cats = db.prepare('SELECT id,name,type FROM categories').all() as Array<{
  id: number; name: string; type: string;
}>;
const catByName = new Map(cats.map((c) => [c.name, c]));

const txStmt = db.prepare(
  `SELECT type, COUNT(*) c FROM transactions WHERE name = ? AND categoryId IS NULL GROUP BY type`,
);
const allTxStmt = db.prepare(
  `SELECT type, COUNT(*) c FROM transactions WHERE name = ? GROUP BY type`,
);

interface Info {
  types: Record<string, number>;
  allTypes: Record<string, number>;
  catType: string | null;
}
const infos = new Map<string, Info>();
for (const m of map.mappings) {
  if (infos.has(m.merchant)) continue;
  const t = txStmt.all(m.merchant) as Array<{ type: string; c: number }>;
  const a = allTxStmt.all(m.merchant) as Array<{ type: string; c: number }>;
  const cat = m.category ? catByName.get(m.category) : undefined;
  infos.set(m.merchant, {
    types: Object.fromEntries(t.map((r) => [r.type, r.c])),
    allTypes: Object.fromEntries(a.map((r) => [r.type, r.c])),
    catType: cat ? cat.type : null,
  });
}

// 汇总
let covered = 0;
let uncovered = 0;
const problems: string[] = [];
const perEntry: Array<Record<string, unknown>> = [];

for (const m of map.mappings) {
  const info = infos.get(m.merchant)!;
  const types = Object.keys(info.types);
  if (m.category && types.length === 0) problems.push(`映射有分类但库里无未分类流水: ${m.merchant} -> ${m.category}`);
  if (m.category) covered += Object.values(info.types).reduce((a, b) => a + b, 0);
  else uncovered += Object.values(info.types).reduce((a, b) => a + b, 0);
  perEntry.push({ merchant: m.merchant, category: m.category, ...info });
}

console.log('=== 映射条目 ===', map.mappings.length);
console.log('=== 分类名全部命中 categories 表 ===',
  map.mappings.every((m) => !m.category || catByName.has(m.category)));
console.log('=== 按条目统计的未分类流水覆盖 ===');
console.log('  可回填(有分类):', covered, ' 不可回填(空分类):', uncovered);

// 方向一致性检查：category.type 与该 merchant 实际出现的 type 是否一致
const dirMismatch: string[] = [];
const multiTypeNoCat: string[] = [];
for (const m of map.mappings) {
  const info = infos.get(m.merchant)!;
  if (!m.category) continue;
  const types = Object.keys(info.allTypes);
  if (types.length > 1) multiTypeNoCat.push(`${m.merchant} 同时出现 ${types.join(',')} -> 分类 ${m.category}(${info.catType})`);
  if (info.catType && !types.includes(info.catType)) {
    dirMismatch.push(`${m.merchant}: 分类 ${m.category}(${info.catType}) vs 交易类型 ${types.join(',') || '(无)'}`);
  }
}
console.log('\n=== 方向不一致(分类type vs 交易type) ===', dirMismatch.length);
dirMismatch.forEach((p) => console.log('  !', p));
console.log('\n=== 同名但库里多方向并存、且本条有分类 ===', multiTypeNoCat.length);
multiTypeNoCat.forEach((p) => console.log('  ?', p));
console.log('\n=== 其它问题 ===', problems.length);
problems.slice(0, 30).forEach((p) => console.log('  !', p));

// 7 个双条目商户的方向拆分
console.log('\n=== 双条目商户方向拆分 ===');
const byM = new Map<string, typeof map.mappings>();
for (const m of map.mappings) {
  const arr = byM.get(m.merchant) ?? [];
  arr.push(m);
  byM.set(m.merchant, arr);
}
for (const [k, arr] of byM) {
  if (arr.length < 2) continue;
  const info = infos.get(k)!;
  console.log(`  ${k}  库内(type→条数): ${JSON.stringify(info.allTypes)}  未分类: ${JSON.stringify(info.types)}`);
  for (const m of arr) {
    const c = catByName.get(m.category);
    console.log(`     - ${m.category || '(空)'} [${c ? c.type + '#' + c.id : '-'}] ${m.reason.slice(0, 28)}`);
  }
}

// 全库未分类里，不在映射 name 集合内的
const names = new Set(map.mappings.map((m) => m.merchant));
const orphans = db
  .prepare(`SELECT name, type, COUNT(*) c FROM transactions WHERE categoryId IS NULL GROUP BY name, type`)
  .all() as Array<{ name: string; type: string; c: number }>;
const orphanRows = orphans.filter((r) => !names.has(r.name));
console.log('\n=== 未分类但不在映射内的 name/type 组 ===', orphanRows.length, '共',
  orphanRows.reduce((a, b) => a + b.c, 0), '笔');
orphanRows.forEach((r) => console.log('  -', r.name, r.type, r.c));
