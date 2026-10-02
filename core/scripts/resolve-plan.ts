/**
 * 只读分析（第二步）：逐笔解析 483 笔未分类流水的分类归属
 * 方向口径：映射条目没有 type 列，用 categories.type 作为该条目的方向
 *   category.type = 'expense' → 只作用于 type='expense' 的流水
 *   category.type = 'income'  → 只作用于 type='income'  的流水
 */
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const db = new Database(resolve('data/hifin.db'), { readonly: true });
const map = JSON.parse(readFileSync('/tmp/merchant-classification.work.json', 'utf8')) as {
  mappings: Array<{ merchant: string; category: string }>;
};
const cats = db.prepare('SELECT id,name,type FROM categories').all() as Array<{
  id: number; name: string; type: string;
}>;
const catByName = new Map(cats.map((c) => [c.name, c]));

// (name, direction) -> entry
const idx = new Map<string, { cat: string; catType: string; catId: number }>();
const conflicts: string[] = [];
for (const m of map.mappings) {
  if (!m.category) continue;
  const c = catByName.get(m.category);
  if (!c) throw new Error(`未知分类 ${m.category}`);
  const key = `${m.merchant}\u0000${c.type}`;
  if (idx.has(key)) conflicts.push(`${m.merchant}/${c.type} 出现两条（${idx.get(key)!.cat} vs ${m.category}）`);
  idx.set(key, { cat: m.category, catType: c.type, catId: c.id });
}

const rows = db
  .prepare('SELECT id, type, name, amount, date FROM transactions WHERE categoryId IS NULL ORDER BY id')
  .all() as Array<{ id: number; type: string; name: string; amount: number; date: number }>;

const fill: Array<{ id: number; catId: number; cat: string; catType: string }> = [];
const skipSameType = new Map<string, number>();
const skipNoEntry = new Map<string, number>();
const skipAmbiguous: string[] = [];

for (const r of rows) {
  const hit = idx.get(`${r.name}\u0000${r.type}`);
  if (hit) {
    fill.push({ id: r.id, catId: hit.catId, cat: hit.cat, catType: hit.catType });
  } else {
    // 记录原因
    const anyDir = new Set<string>();
    for (const m of map.mappings) {
      if (m.merchant !== r.name) continue;
      const c = m.category ? catByName.get(m.category) : undefined;
      anyDir.add(c ? c.type : '(空分类)');
    }
    if (anyDir.size === 0) skipNoEntry.set(`${r.name}/${r.type}`, (skipNoEntry.get(`${r.name}/${r.type}`) ?? 0) + 1);
    else if (anyDir.has('(空分类)')) skipSameType.set(`${r.name}/${r.type} (该方向无条目)`, (skipSameType.get(`${r.name}/${r.type} (该方向无条目)`) ?? 0) + 1);
    else skipAmbiguous.push(`${r.name}/${r.type} 方向 ${[...anyDir].join(',')} 都有条目但未命中`);
  }
}

console.log('=== 方向索引冲突 ===', conflicts.length);
conflicts.forEach((c) => console.log('  !', c));
console.log('=== 未分类总笔数 ===', rows.length);
console.log('=== 可回填(方向匹配) ===', fill.length);
console.log('=== 不可回填 ===', rows.length - fill.length);
console.log('\n-- 不可回填明细 --');
const skipAll = new Map<string, string>();
for (const [k, v] of skipSameType) skipAll.set(k, v + ' 笔（该方向无映射条目）');
for (const [k, v] of skipNoEntry) skipAll.set(k, v + ' 笔（映射无此 name）');
[...skipAll.entries()].forEach(([k, v]) => console.log('  -', k, v));
skipAmbiguous.forEach((s) => console.log('  !', s));

console.log('\n=== 按方向统计可回填 ===');
const byDir: Record<string, number> = {};
for (const f of fill) byDir[f.catType] = (byDir[f.catType] ?? 0) + 1;
console.log(byDir);

console.log('\n=== 按分类统计 ===');
const byCat: Record<string, number> = {};
for (const f of fill) byCat[f.cat] = (byCat[f.cat] ?? 0) + 1;
Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('  ', k, v));

// 回填后残留
const remaining = rows.length - fill.length;
console.log('\n=== 回填后残留未分类 ===', remaining, `(${((remaining / 483) * 100).toFixed(1)}%)`);

// keyword 互相包含（引擎是 includes 匹配，短词会误吞长词）
const keywords = [...idx.entries()].map(([k, v]) => ({ kw: k.split('\u0000')[0], dir: v.catType, cat: v.cat }));
const kwSet = new Set(keywords.map((k) => k.kw));
console.log('\n=== keyword 互相 contains 的对（子串, 长度>=2）===');
let pairs = 0;
for (const a of keywords) {
  for (const b of keywords) {
    if (a === b || a.dir !== b.dir) continue;
    if (a.kw.length < 2) continue;
    if (b.kw.toLowerCase().includes(a.kw.toLowerCase()) && a.kw !== b.kw) {
      pairs++;
      if (pairs <= 25) console.log(`   "${a.kw}"(${a.cat}) ⊂ "${b.kw}"(${b.cat})`);
    }
  }
}
console.log('   总对数:', pairs);
console.log('\n=== 库内最短 keyword（<3 字符, 误匹配风险高）===');
keywords.filter((k) => k.kw.length < 3).forEach((k) => console.log('   ', JSON.stringify(k.kw), k.cat));
