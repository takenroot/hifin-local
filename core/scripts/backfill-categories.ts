/**
 * 一次性回填脚本：给存量交易补上 categoryId
 * -----------------------------------------------------------------
 * 背景：库里 817 笔交易导入时 categoryId 全是 NULL（规则表为空，账单自带的
 * 「交易分类」/「交易类型」那会儿还没接进来）。现在解析链和映射表都就位了，
 * 用账单原件把这批存量补上。
 *
 * 做法：**重新解析账单原件** → 建一张"四元组 → 分类名"的索引 → 逐笔回查。
 * 刻意不碰 amount/balance/type/date，只 UPDATE categoryId 一个字段。
 *
 * 匹配键 (accountId, amount, date, name) 与导入器去重用的键完全一致，所以
 * "库里存在" 与 "原件存在" 是同一口径：原件里有、库里有 key 相同的一行，
 * 就能确定说的是同一笔交易。
 *
 * 用法：
 *   npx tsx scripts/backfill-categories.ts              # dry-run，只报告不动库
 *   npx tsx scripts/backfill-categories.ts --apply      # 真正写库
 *   npx tsx scripts/backfill-categories.ts --help
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipBill, findBillCsv } from '../src/bill/unzip.js';
import { xlsxToCsvText } from '../src/bill/importer.js';
import { resolveBillCategory } from '../src/bill/category-map.js';
import { parseCsvText } from '../../app/src/features/transactions/csv.ts';

const CORE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

interface Args {
  apply: boolean;
  db: string;
  alipay: string;
  alipayPassword: string;
  wechat: string;
  limit: number | null;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    apply: false,
    db: resolve(CORE_ROOT, 'data', 'hifin.db'),
    alipay: '/tmp/check-alipay.zip',
    alipayPassword: '',   // 必填：解压密码一次性，禁止默认值（安全规约）
    wechat: '/tmp/check-wechat.xlsx',
    limit: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = (): string => {
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`参数 ${k} 后面缺值`);
      i++;
      return next;
    };
    switch (k) {
      case '--apply':
        a.apply = true;
        break;
      case '--db':
        a.db = resolve(v());
        break;
      case '--alipay':
        a.alipay = resolve(v());
        break;
      case '--alipay-password':
        a.alipayPassword = v();
        break;
      case '--wechat':
        a.wechat = resolve(v());
        break;
      case '--limit':
        a.limit = Number(v());
        break;
      case '--help':
      case '-h':
        console.log(
          [
            '用法: npx tsx scripts/backfill-categories.ts [选项]',
            '',
            '  --apply               真正写库（缺省是 dry-run，只打印报告）',
            '  --db <path>           数据库路径（默认 core/data/hifin.db）',
            '  --alipay <path>       支付宝账单 ZIP（默认 /tmp/check-alipay.zip）',
            '  --alipay-password <p> 支付宝账单解压密码（必填，一次性密码无默认值）',
            '  --wechat <path>       微信账单 xlsx（默认 /tmp/check-wechat.xlsx）',
            '  --limit <n>           只处理前 n 笔待回填交易（试跑用）',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${k}（--help 看用法）`);
    }
  }
  return a;
}

/* ── 账单原件 → 逐行分类 ────────────────────────────────────── */

interface BillRow {
  /** 匹配键 */
  key: string;
  /** 解析出的分类名；不可映射时为 null */
  category: string | null;
  /** 该行账单原始分类值，用于报告里解释"为什么没分类" */
  raw: string;
  /** 该笔的收支方向 */
  dir: 'expense' | 'income';
  /** 来源平台 */
  platform: 'alipay' | 'wechat';
}

function matchKey(accountId: number, amount: number, date: number, name: string): string {
  // 金额统一按两位小数归一：SQLite REAL 与 JS number 都是 IEEE754 双精度，
  // 同样的十进制串两边算出来本该一致，但 toFixed(2) 顺手消掉 "8.88" vs
  // "8.880000000000001" 这类浮点尾差，省得排查半天。
  return `${accountId}|${amount.toFixed(2)}|${date}|${name}`;
}

/** 从 app 的 parseCsvText 结果里抽出"四元组 + 分类名" */
function rowsFromParse(
  items: Array<{ date: number; amount: number; type: string; merchant: string; billCategory?: string; rawLine?: string }>,
  platform: 'alipay' | 'wechat',
  accountId: number,
): BillRow[] {
  const out: BillRow[] = [];
  for (const it of items) {
    // 解析失败的行 / 不计收支的行：跟导入器一致，本来就没进库
    if (it.rawLine || !it.date || !it.amount) continue;
    if (it.type !== 'expense' && it.type !== 'income') continue;
    const dir = it.type;
    out.push({
      key: matchKey(accountId, it.amount, it.date, it.merchant || '账单导入'),
      category: resolveBillCategory(platform, it.billCategory ?? '', dir),
      raw: (it.billCategory ?? '').trim(),
      dir,
      platform,
    });
  }
  return out;
}

function parseAlipay(path: string, password: string, accountId: number): BillRow[] {
  const files = unzipBill(path, password);
  const csv = findBillCsv(files);
  if (!csv) throw new Error(`${basename(path)} 里没找到 CSV 账单表格`);
  const buf = readFileSync(csv);
  let text: string;
  try {
    text = new TextDecoder('gbk', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('utf-8').decode(buf);
  }
  // 与 importer 同样地剥掉导出说明：第一个含"交易时间"的行才是表头
  const lines = text.split(/\r?\n/);
  const hi = lines.findIndex((l) => l.includes('交易时间') || l.includes('日期'));
  if (hi > 0) text = lines.slice(hi).join('\n');
  const parsed = parseCsvText(text, 'alipay');
  return rowsFromParse(parsed.items, 'alipay', accountId);
}

function parseWechat(path: string, accountId: number): BillRow[] {
  const text = xlsxToCsvText(path);
  const parsed = parseCsvText(text, 'wechat');
  return rowsFromParse(parsed.items, 'wechat', accountId);
}

/* ── 主流程 ────────────────────────────────────────────────── */

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db);
  // REST 服务（:8787）可能正连着同一个库；WAL 下并发读写没问题，
  // 但拿不到写锁时要等一会儿而不是立刻 SQLITE_BUSY
  db.pragma('busy_timeout = 10000');

  console.log('═'.repeat(72));
  console.log('hifin 存量交易分类回填');
  console.log('═'.repeat(72));
  console.log(`数据库      : ${args.db}`);
  if (!args.alipayPassword) {
    console.error('错误：--alipay-password 必填（解压密码一次性，不提供默认值）');
    process.exit(1);
  }
  console.log(`支付宝账单  : ${args.alipay} (密码已提供)`);
  console.log(`微信账单    : ${args.wechat}`);
  console.log(`模式        : ${args.apply ? 'APPLY（会写库）' : 'DRY-RUN（只读，不写库）'}`);
  console.log('');

  // ── 0. 定位账单所属账户 ──
  // 匹配键里带 accountId（与导入器去重口径一致），所以得先知道这两份账单当初
  // 导进了哪个账户。取交易最多的那个；库里若有多个账户都有流水，会明确提示，
  // 因为这意味着"哪份账单属于哪个账户"需要人来确认，脚本不替你猜。
  const byAccount = db
    .prepare('SELECT accountId, COUNT(*) c FROM transactions GROUP BY accountId ORDER BY c DESC')
    .all() as Array<{ accountId: number; c: number }>;
  if (byAccount.length === 0) throw new Error('库里没有交易，无从回填');
  const accountId = byAccount[0].accountId;
  console.log(`账单所属账户：#${accountId}（${byAccount[0].c} 笔）`);
  if (byAccount.length > 1) {
    console.log(
      `⚠ 库里还有其它有流水的账户（${byAccount
        .slice(1)
        .map((a) => `#${a.accountId}×${a.c}`)
        .join('、')}），它们的交易不会与这两份账单匹配`,
    );
  }
  console.log('');

  // ── 1. 解析账单原件 ──
  const aliRows = parseAlipay(args.alipay, args.alipayPassword, accountId);
  const wxRows = parseWechat(args.wechat, accountId);
  const billRows = [...aliRows, ...wxRows];
  console.log(`账单原件收支行：支付宝 ${aliRows.length} + 微信 ${wxRows.length} = ${billRows.length} 行`);

  // key → 该四元组出现过的所有分类名（多个不同名字 = 冲突）
  const keyToNames = new Map<string, Set<string>>();
  const keyToRaw = new Map<string, string>();
  const keyToPlatform = new Map<string, string>();
  for (const r of billRows) {
    if (!keyToRaw.has(r.key)) keyToRaw.set(r.key, r.raw);
    if (!keyToPlatform.has(r.key)) keyToPlatform.set(r.key, r.platform);
    if (r.category === null) continue;
    if (!keyToNames.has(r.key)) keyToNames.set(r.key, new Set());
    keyToNames.get(r.key)!.add(r.category);
  }
  const keys = new Set(billRows.map((r) => r.key));
  // 账单里四元组重复的原件行，导入时会被去重跳过，所以原件行数 > 库里笔数是正常的。
  // 把这个差值打出来，是为了说明"为什么账单 837 行而库里 817 笔"，
  // 免得报告里两个数字对不上时让人以为解析跑偏了。
  console.log(`去重后四元组  ：${keys.size} 个（原件有 ${billRows.length - keys.size} 行与其它行四元组重复，导入时已去重）`);
  console.log('');

  // ── 2. 分类名 → categoryId（顺带按收支方向复查）──
  interface CategoryRow {
    id: number;
    name: string;
    type: string;
  }
  const cats = db.prepare('SELECT id, name, type FROM categories').all() as CategoryRow[];
  const byName = new Map<string, CategoryRow>();
  for (const c of cats) if (!byName.has(c.name)) byName.set(c.name, c);

  // ── 3. 扫待回填交易 ──
  interface TxRow {
    id: number;
    name: string;
    amount: number;
    date: number;
    type: string;
    accountId: number;
  }
  const targets = db
    .prepare('SELECT id, name, amount, date, type, accountId FROM transactions WHERE categoryId IS NULL ORDER BY id')
    .all() as TxRow[];
  const scanned = args.limit === null ? targets : targets.slice(0, args.limit);

  // ── 2.5 分平台覆盖率（对**全部**交易算，与库里当前是否已填无关）──
  // 回填完再跑一次时，待回填集合已经空了，但"支付宝覆盖了多少"这个问题仍然
  // 值得能回答，所以这里独立地对全表扫一遍。
  {
    const all = db
      .prepare('SELECT id, name, amount, date, type, accountId FROM transactions ORDER BY id')
      .all() as TxRow[];
    const cov = new Map<string, { total: number; mapped: number }>();
    let noSource = 0;
    for (const t of all) {
      const key = matchKey(t.accountId, t.amount, t.date, t.name);
      const p = keyToPlatform.get(key);
      if (!p) {
        noSource++;
        continue;
      }
      const slot = cov.get(p) ?? { total: 0, mapped: 0 };
      slot.total++;
      if (keyToNames.get(key)?.size) slot.mapped++;
      cov.set(p, slot);
    }
    console.log('分平台覆盖率（按账单原件四元组反查全表，与库里当前值无关）：');
    for (const p of ['alipay', 'wechat'] as const) {
      const c = cov.get(p);
      if (!c) continue;
      const label = p === 'alipay' ? '支付宝' : '微信  ';
      console.log(`  ${label} ${String(c.total).padStart(3)} 笔 → 可判定分类 ${String(c.mapped).padStart(3)} 笔  ${pct(c.mapped, c.total)}`);
    }
    if (noSource > 0) console.log(`  其它（两份账单都找不到对应行）：${noSource} 笔`);
    console.log('');
  }

  interface Plan {
    id: number;
    name: string;
    amount: number;
    date: number;
    type: string;
    categoryId: number;
    categoryName: string;
    raw: string;
  }
  const plan: Plan[] = [];
  const unmatched: TxRow[] = []; // 原件里找不到对应行
  const unmapped: Array<TxRow & { raw: string }> = []; // 找得到行，但映射不产生分类
  const conflicts: Array<TxRow & { names: string[] }> = []; // 同一四元组对应多个不同分类
  const typeBlocked: Array<TxRow & { categoryName: string }> = []; // 名字在，但收支方向不匹配

  for (const t of scanned) {
    const key = matchKey(t.accountId, t.amount, t.date, t.name);
    if (!keys.has(key)) {
      unmatched.push(t);
      continue;
    }
    const names = keyToNames.get(key);
    if (!names || names.size === 0) {
      unmapped.push({ ...t, raw: keyToRaw.get(key) ?? '' });
      continue;
    }
    if (names.size > 1) {
      conflicts.push({ ...t, names: [...names] });
      continue;
    }
    const categoryName = [...names][0];
    const row = byName.get(categoryName);
    if (!row) {
      // 映射到了名字但库里没有这个分类：不该发生（种子表是配套的），报出来
      unmapped.push({ ...t, raw: `${keyToRaw.get(key) ?? ''} → ${categoryName}(库里无此分类)` });
      continue;
    }
    if (row.type !== t.type) {
      typeBlocked.push({ ...t, categoryName });
      continue;
    }
    plan.push({
      id: t.id,
      name: t.name,
      amount: t.amount,
      date: t.date,
      type: t.type,
      categoryId: row.id,
      categoryName,
      raw: keyToRaw.get(key) ?? '',
    });
  }

  // ── 4. 报告 ──
  const total = scanned.length;
  console.log('─'.repeat(72));
  console.log('扫描结果');
  console.log('─'.repeat(72));
  console.log(`待回填交易（categoryId IS NULL）：${total}`);
  console.log(`  计划写入                ：${plan.length}  (${pct(plan.length, total)})`);
  console.log(`  原件无对应行 → 保持 NULL：${unmatched.length}  (${pct(unmatched.length, total)})`);
  console.log(`  匹配到但映射不产生分类  ：${unmapped.length}  (${pct(unmapped.length, total)})`);
  console.log(`  分类名查不到            ：${typeBlocked.length}`);
  console.log(`  四元组多分类冲突（跳过） ：${conflicts.length}`);
  console.log('');

  // 分类分布 Top10
  const dist = new Map<string, number>();
  for (const p of plan) dist.set(p.categoryName, (dist.get(p.categoryName) ?? 0) + 1);
  console.log('计划写入的分类分布（Top10）：');
  const sorted = [...dist.entries()].sort((a, b) => b[1] - a[1]);
  for (const [name, n] of sorted.slice(0, 10)) {
    const c = byName.get(name)!;
    console.log(`  ${name.padEnd(6, '　')} id=${String(c.id).padStart(2)} ${String(n).padStart(4)} 笔  ${bar(n, plan.length)}`);
  }
  if (sorted.length > 10) {
    console.log(`  …另有 ${sorted.length - 10} 个分类：${sorted.slice(10).map(([k, v]) => `${k}×${v}`).join('、')}`);
  }
  console.log('');

  // 保持 NULL 的原因分组
  const unmappedByRaw = new Map<string, number>();
  for (const u of unmapped) unmappedByRaw.set(u.raw || '(空)', (unmappedByRaw.get(u.raw || '(空)') ?? 0) + 1);
  console.log('保持 NULL 的原因分组：');
  console.log('  A) 原件里根本没有这一行：');
  for (const u of unmatched.slice(0, 5)) console.log(`     #${u.id} ${u.type === 'expense' ? '支出' : '收入'} ${u.amount} ${u.name} @ ${new Date(u.date).toLocaleString('zh-CN')}`);
  if (unmatched.length > 5) console.log(`     …另 ${unmatched.length - 5} 笔`);
  console.log('  B) 行匹配上了，但账单分类不足以判定（留给规则引擎）：');
  for (const [raw, n] of [...unmappedByRaw.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`     账单「${raw}」× ${n}`);
  }
  if (conflicts.length > 0) {
    console.log('  C) 同一四元组在原件里对应不同分类（已跳过，需人工确认）：');
    for (const c of conflicts.slice(0, 10)) {
      console.log(`     #${c.id} ${c.name} ${c.amount} @ ${new Date(c.date).toLocaleString('zh-CN')} → ${c.names.join(' / ')}`);
    }
    if (conflicts.length > 10) console.log(`     …另 ${conflicts.length - 10} 笔`);
  }
  console.log('');

  // ── 5. 写库（仅 --apply）──
  if (!args.apply) {
    console.log('DRY-RUN 结束：未改动数据库。确认无误后加 --apply 执行。');
    snapshotAndClose(db);
    return;
  }

  // 写前留一份"不该变"的字段快照，写完逐项对账
  const before = invariantSnapshot(db);

  const upd = db.prepare('UPDATE transactions SET categoryId = ? WHERE id = ? AND categoryId IS NULL');
  const run = db.transaction((rows: Plan[]) => {
    let n = 0;
    for (const p of rows) n += upd.run(p.categoryId, p.id).changes;
    return n;
  });
  const written = run(plan);

  const after = invariantSnapshot(db);
  console.log('─'.repeat(72));
  console.log('写入完成');
  console.log('─'.repeat(72));
  console.log(`实际 UPDATE 行数：${written}（计划 ${plan.length}）`);
  const nullAfter = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE categoryId IS NULL').get() as { c: number }).c;
  console.log(`回填后 categoryId IS NULL：${nullAfter} / ${before.txCount}`);
  console.log('');
  const diffs = diffInvariants(before, after);
  if (diffs.length === 0) {
    console.log('✔ 不变量校验通过：amount / date / type / accountId / accounts.balance 全部未变');
  } else {
    console.log('✘ 不变量校验失败：');
    for (const d of diffs) console.log(`   ${d}`);
    process.exitCode = 1;
  }
  snapshotAndClose(db);
}

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function bar(n: number, total: number): string {
  if (total === 0) return '';
  const w = Math.max(1, Math.round((n / total) * 40));
  return '█'.repeat(w);
}

interface Invariants {
  txCount: number;
  nullCount: number;
  amountSum: number;
  dateMin: number;
  dateMax: number;
  typeDist: string;
  balance: number;
}

/** 抓一份"本脚本绝不该改动"的字段指纹 */
function invariantSnapshot(db: Database.Database): Invariants {
  const agg = db
    .prepare(
      `SELECT COUNT(*) txCount,
              SUM(categoryId IS NULL) nullCount,
              COALESCE(SUM(amount),0) amountSum,
              COALESCE(MIN(date),0) dateMin,
              COALESCE(MAX(date),0) dateMax
         FROM transactions`,
    )
    .get() as { txCount: number; nullCount: number; amountSum: number; dateMin: number; dateMax: number };
  const types = db.prepare('SELECT type, COUNT(*) c FROM transactions GROUP BY type ORDER BY type').all() as Array<{ type: string; c: number }>;
  const bal = db.prepare('SELECT COALESCE(SUM(balance),0) s FROM accounts').get() as { s: number };
  return {
    ...agg,
    typeDist: types.map((t) => `${t.type}:${t.c}`).join(','),
    balance: bal.s,
  };
}

function diffInvariants(before: Invariants, after: Invariants): string[] {
  const out: string[] = [];
  // nullCount 是本脚本**要**改的字段，单独比：它只允许减少
  if (after.txCount !== before.txCount) out.push(`交易笔数变了：${before.txCount} → ${after.txCount}`);
  if (Math.abs(after.amountSum - before.amountSum) > 1e-6) out.push(`金额总和变了：${before.amountSum} → ${after.amountSum}`);
  if (after.dateMin !== before.dateMin) out.push(`最早交易时间变了：${before.dateMin} → ${after.dateMin}`);
  if (after.dateMax !== before.dateMax) out.push(`最晚交易时间变了：${before.dateMax} → ${after.dateMax}`);
  if (after.typeDist !== before.typeDist) out.push(`收支类型分布变了：${before.typeDist} → ${after.typeDist}`);
  if (Math.abs(after.balance - before.balance) > 1e-6) out.push(`账户余额总和变了：${before.balance} → ${after.balance}`);
  if (after.nullCount > before.nullCount) out.push(`NULL 反而变多了：${before.nullCount} → ${after.nullCount}`);
  return out;
}

function snapshotAndClose(db: Database.Database): void {
  const nullNow = (db.prepare('SELECT COUNT(*) c FROM transactions WHERE categoryId IS NULL').get() as { c: number }).c;
  const total = (db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c;
  const acc = db.prepare('SELECT id, name, balance FROM accounts ORDER BY id').all() as Array<{ id: number; name: string; balance: number }>;
  console.log('─'.repeat(72));
  console.log('库现状');
  console.log('─'.repeat(72));
  console.log(`交易 ${total} 笔，其中 categoryId IS NULL ${nullNow} 笔（已分类 ${total - nullNow} 笔，${pct(total - nullNow, total)}）`);
  for (const a of acc) console.log(`账户 #${a.id} ${a.name} balance = ${a.balance}`);
  db.close();
}

main();
