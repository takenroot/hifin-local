/**
 * 一次性脚本：禁用单字符 keyword 的规则（enabled 0 → 1）
 * -----------------------------------------------------------------
 * 为什么禁：规则匹配是 **includes 子串匹配**，不是整名相等。单个字符的
 * keyword 在这个语义下几乎必然误命中——实测 keyword="平" 指向"人情往来"，
 * 库里"拼多多平台商户"这笔就被它抢走了分类（该行真实分类是"日用百货"）。
 * 单字符规则提供的信息量抵不上它的误伤面，直接停用；用户仍可在 UI 上改回。
 *
 * 判据用 SQL 的 `length(keyword) < 2` 而不是 JS 的 `keyword.length < 2`：
 * SQLite 的 length() 按**字符（码点）**计数，而 JS 的 String.length 按
 * **UTF-16 码元**计数。规则库里那条 keyword="💫" 的规则，两边结论相反——
 * JS 算 2（代理对）会漏掉它，SQL 算 1 才是我们要的。所以判据必须留在 SQL 里。
 *
 * 范围：只 UPDATE rules.enabled，绝不碰 transactions 任何字段。
 * 幂等：已经停用的不会重复处理，重跑只会报"新增 0 条"。
 *
 * 用法：
 *   npx tsx scripts/disable-short-rules.ts            # dry-run
 *   npx tsx scripts/disable-short-rules.ts --apply
 */
import Database from 'better-sqlite3';
import { resolve } from 'node:path';

const APPLY = process.argv.slice(2).includes('--apply');
const db = new Database(resolve('data/hifin.db'));
db.pragma('busy_timeout = 10000');   // :8787 的 REST 服务可能同时在读

interface ShortRule {
  id: number;
  keyword: string;
  categoryId: number;
  category: string;
  catType: string;
  enabled: number;
  charLen: number;
}

const targets = db
  .prepare(
    `SELECT r.id, r.keyword, r.categoryId, r.enabled,
            c.name AS category, c.type AS catType,
            length(r.keyword) AS charLen
       FROM rules r
       LEFT JOIN categories c ON c.id = r.categoryId
      WHERE length(r.keyword) < 2
      ORDER BY r.id`,
  )
  .all() as ShortRule[];

const toDisable = targets.filter((r) => r.enabled === 1);
const alreadyOff = targets.filter((r) => r.enabled === 0);

const merchantNames = (
  db.prepare('SELECT DISTINCT name FROM transactions').all() as Array<{ name: string }>
).map((r) => r.name);

console.log('=== 单字符 keyword 规则清单（SQL length() 按码点计）===');
console.log('命中判据 length(keyword) < 2:', targets.length, '条 | 其中 enabled=1 待禁用:', toDisable.length,
  '| 已经 enabled=0:', alreadyOff.length, '条');
for (const r of targets) {
  // 误伤证据：库内有多少个**不等于**该 keyword 的商户名会被它 includes 命中
  const collateral = merchantNames.filter((n) => n !== r.keyword && n.includes(r.keyword));
  console.log(
    `  #${r.id} ${JSON.stringify(r.keyword)} (码点数=${r.charLen}) → ${r.category ?? '分类不存在'}(${r.catType ?? '-'})` +
    `  enabled=${r.enabled}` +
    (collateral.length ? `  ⚠ 会额外命中 ${collateral.length} 个不同名商户: ${collateral.slice(0, 3).map((c) => JSON.stringify(c)).join(', ')}` : ''),
  );
}

/** 停用前的自检：清单里必须**全部**真的是单字符，否则说明判据写歪了 */
const bad = toDisable.filter((r) => [...r.keyword].length >= 2);
if (bad.length > 0) {
  console.error('❌ 自检失败：以下规则并非单字符，拒绝执行：', bad.map((r) => `#${r.id} ${r.keyword}`));
  process.exit(1);
}

if (!APPLY) {
  console.log('\n[dry-run] 未写库。加 --apply 真正执行。');
  db.close();
  process.exit(0);
}

const before = (db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 1').get() as { c: number }).c;
const off = db.prepare('UPDATE rules SET enabled = 0 WHERE length(keyword) < 2 AND enabled = 1').run();
const after = (db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 1').get() as { c: number }).c;

console.log('\n=== 已执行 ===');
console.log('规则总数:', (db.prepare('SELECT COUNT(*) c FROM rules').get() as { c: number }).c, '（不变）');
console.log('enabled=1:', before, '->', after, `| 本次实际更新 ${off.changes} 行`);
console.log('enabled=0:', (db.prepare('SELECT COUNT(*) c FROM rules WHERE enabled = 0').get() as { c: number }).c);
db.close();
