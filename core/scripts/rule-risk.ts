/**
 * 只读回放：量化 rules 表两个"设计层面"风险面在**修复前 / 修复后**的对比
 * -----------------------------------------------------------------
 * 跑法是两种口径各回放一遍同一批 817 笔存量流水，输出对照表：
 *
 *   修复前（legacy）= 全部 226 条规则（等价于当初 enabled 全为 1 的状态）
 *                     + 无方向闸门
 *   修复后（fixed） = enabled=1 的 224 条（单字符规则已停用）
 *                     + 有方向闸门（categories.type 必须等于流水 type）
 *
 * 为什么要单独造一个"legacy 规则集"：单字符规则已经被
 * scripts/disable-short-rules.ts 停用，库里读不到它们了。要让"修复前"这一列
 * 仍然是当初那 226 条的真实回放（而不是"226 条里少 2 条"的另一个东西），
 * 就得把它显式还原出来——判据是 `enabled = 1 OR length(keyword) < 2`，
 * 恰好是那条 UPDATE 的逆运算。脚本开头会打印规则集条数，legacy 应为 226。
 *
 * 方向闸门的口径必须和 src/mail/importer.ts 的 makeRuleMatcher 一致：
 * 规则指向的 categories.type ≠ 流水 type 就跳过这条、继续匹配下一条。
 * 两边各写一遍是这个脚本的已知弱点，改闸门时两处都要跟着改。
 *
 * 本脚本只读，绝不写库。
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const db = new Database(resolve('data/hifin.db'), { readonly: true });

const cats = db.prepare('SELECT id,name,type FROM categories').all() as Array<{ id: number; name: string; type: string }>;
const byId = new Map(cats.map((c) => [c.id, c]));

interface Rule { keyword: string; categoryId: number }
function loadRules(sql: string): Rule[] {
  return db.prepare(sql).all() as Rule[];
}

const allRules = loadRules('SELECT keyword, categoryId FROM rules ORDER BY priority DESC, createdAt ASC');
const legacyRules = loadRules(
  `SELECT keyword, categoryId FROM rules
    WHERE enabled = 1 OR length(keyword) < 2      -- 还原"停用单字符规则之前"的状态
    ORDER BY priority DESC, createdAt ASC`,
);
const fixedRules = loadRules(
  'SELECT keyword, categoryId FROM rules WHERE enabled = 1 ORDER BY priority DESC, createdAt ASC',
);

const tx = db.prepare('SELECT id,type,name,categoryId FROM transactions').all() as Array<{ id: number; type: string; name: string; categoryId: number | null }>;

/**
 * 回放一遍规则引擎。
 * @param gate 是否启用方向闸门（false = 修复前语义）
 */
function replay(rules: Rule[], gate: boolean) {
  const match = (m: string, t: string) => {
    for (const r of rules) {
      const kw = (r.keyword || '').trim();
      if (!kw) continue;
      if (gate) {
        const cat = byId.get(r.categoryId);
        // 悬空 categoryId 的 categoryType 是 null，永远 ≠ 任何流水方向 → 跳过
        if (!cat || cat.type !== t) continue;
      }
      if (m.includes(kw)) return r;
    }
    return null;
  };

  let cross = 0; let same = 0;
  const crossRows: string[] = []; const sameRows: string[] = [];
  const viaKw = new Map<string, number>();
  for (const t of tx) {
    const via = match(t.name, t.type);
    if (!via) continue;
    const c = byId.get(via.categoryId)!;
    const cur = t.categoryId ? byId.get(t.categoryId) : null;
    if (c.type !== t.type) {
      cross++;
      if (crossRows.length < 10) crossRows.push(`id=${t.id} ${JSON.stringify(t.name)} ${t.type} 现=${cur?.name ?? 'null'} 规则会给=${c.name}(${c.type})`);
    } else if (!cur || cur.id !== c.id) {
      same++;
      const k = `${via.keyword} → ${c.name}（抢了 ${cur?.name ?? 'null'}）`;
      viaKw.set(k, (viaKw.get(k) ?? 0) + 1);
      if (sameRows.length < 10) sameRows.push(`id=${t.id} ${JSON.stringify(t.name)} ${t.type} 现=${cur?.name ?? 'null'} 规则会给=${c.name} 经由 keyword "${via.keyword}"`);
    }
  }
  return { cross, same, crossRows, sameRows, viaKw };
}

const legacy = replay(legacyRules, false);
const fixed = replay(fixedRules, true);

// ── 规则集现状 ──────────────────────────────────────────────────────
const nAll = (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c;
const nOn = (db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 1').get() as { c: number }).c;
const nOff = (db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 0').get() as { c: number }).c;
const shortRows = db
  .prepare(`SELECT id, keyword, enabled FROM rules WHERE length(keyword) < 2 ORDER BY id`)
  .all() as Array<{ id: number; keyword: string; enabled: number }>;

console.log('=== 规则集现状（只读）===');
console.log(`rules 总数 ${nAll} | enabled=1 ${nOn} | enabled=0 ${nOff}`);
console.log('回放用规则集: 修复前', legacyRules.length, '条 | 修复后', fixedRules.length, '条',
  `(注：库内共 ${allRules.length} 条, enabled=0 的单字符规则已按逆运算还原进 legacy)`);
console.log('已停用的单字符规则:',
  shortRows.length ? shortRows.map((r) => `#${r.id} ${JSON.stringify(r.keyword)}(enabled=${r.enabled})`).join(', ') : '无');

// ── 对照表 ──────────────────────────────────────────────────────────
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].length));
console.log('\n=== 风险对照表（全库 817 笔回放）===');
console.log(`${pad('口径', 26)}${pad('跨方向错配', 14)}${pad('同方向被抢占', 16)}说明`);
console.log(`${pad('修复前（226条/无闸门）', 24)}${pad(String(legacy.cross), 12)}${pad(String(legacy.same), 14)}存量已被精确回填纠正，不受影响`);
console.log(`${pad('修复后（224条/有闸门）', 24)}${pad(String(fixed.cross), 12)}${pad(String(fixed.same), 14)}仅影响未来导入`);

// ── 明细 ────────────────────────────────────────────────────────────
console.log('\n=== 修复前 · 跨方向明细（修复后应为 0）===');
legacy.crossRows.forEach((r) => console.log('   ', r));
if (!legacy.crossRows.length) console.log('    （无）');

console.log('\n=== 修复后 · 跨方向明细 ===');
fixed.crossRows.forEach((r) => console.log('   ', r));
if (!fixed.crossRows.length) console.log('    （无）');

console.log('\n=== 修复前 · 造成同方向抢占的规则 ===');
[...legacy.viaKw.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('   ', k, `(${v} 笔)`));

console.log('\n=== 修复后 · 造成同方向抢占的规则 ===');
if (!fixed.viaKw.size) console.log('    （无）');
[...fixed.viaKw.entries()].sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log('   ', k, `(${v} 笔)`));

// ── 仍存活的短 keyword 风险 ─────────────────────────────────────────
console.log('\n=== 修复后仍启用的短 keyword（<3 字符）——includes 语义下的残留误伤面 ===');
const live = fixedRules.filter((r) => r.keyword.trim().length < 3);
const names = tx.map((t) => t.name);
live.forEach((r) => {
  const c = byId.get(r.categoryId)!;
  const hits = names.filter((n) => n !== r.keyword && n.includes(r.keyword.trim()));
  const foreign = hits.filter((n) => !fixedRules.some((o) => o.keyword === n));
  console.log(`   ${JSON.stringify(r.keyword)} → ${c.name}: 额外命中 ${hits.length} 个非同名商户名` +
    (foreign.length ? `，例: ${foreign.slice(0, 3).map((f) => JSON.stringify(f)).join(', ')}` : ''));
});
console.log(`（共 ${live.length} 条启用中；2 条单字符的已停用，不在此列）`);
