/**
 * 一次性回填脚本：给存量交易补上 source / externalId / paymentMethod / status
 * -----------------------------------------------------------------
 * 背景：库里 817 笔交易（微信 500 + 支付宝 317）是这四个字段加进来**之前**导入的，
 * 全部为 NULL。现在解析链已经能读出平台单号/支付方式/状态了，用账单原件补上。
 *
 * 做法与 backfill-categories.ts 同源：**重新解析账单原件** → 建"四元组 → 行"的索引
 * → 逐笔回查。匹配键 (accountId, amount, date, name) 与导入器去重口径一致，
 * 所以"库里存在"与"原件存在"是同一把尺子。
 *
 * 脚本还顺手做两件配套的事（都在 --apply 时才落库）：
 *   1. 清理 remark='/' 的行 —— 两家账单用半角 "/" 表示"这格没内容"，
 *      存进库里会被当成真的备注。
 *   2. 零钱通账户内部划转的 type 修正（income/expense → 'excluded'），
 *      并**反向调整账户余额**恢复 balance == Σincome - Σexpense 的不变量。
 *
 * 密码不落在任何文件里：走 --alipay-password 参数或 HIFIN_ALIPAY_PASSWORD 环境变量。
 *
 * 用法：
 *   npx tsx scripts/backfill-fields.ts                 # dry-run，只报告不动库
 *   npx tsx scripts/backfill-fields.ts --apply         # 真正写库
 *   npx tsx scripts/backfill-fields.ts --help
 */

import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { basename, dirname as pathDirname, basename as pathBasename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipBill, findBillCsv, cleanupBillDir } from '../src/bill/unzip.js';
import { xlsxToCsvText, normalizeSource } from '../src/bill/importer.js';
import { isWechatInternalTransfer } from '../src/bill/category-map.js';
import { migrate, getUserVersion, getColumns, CURRENT_SCHEMA_VERSION } from '../src/db/migrate.js';
import { parseCsvText } from '../../app/src/features/transactions/csv.ts';

const CORE_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/** 零钱通划转行的备注后缀：让人一眼看出"为什么这行不计收支" */
const TRANSFER_REMARK_SUFFIX = '（账户内部划转）';

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
    // 刻意不给默认值：密码只该出现在命令行或环境变量里，不该被写进仓库
    alipayPassword: process.env.HIFIN_ALIPAY_PASSWORD ?? '',
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
            '用法: npx tsx scripts/backfill-fields.ts [选项]',
            '',
            '  --apply               真正写库（缺省是 dry-run，只打印报告）',
            '  --db <path>           数据库路径（默认 core/data/hifin.db）',
            '  --alipay <path>       支付宝账单 ZIP（默认 /tmp/check-alipay.zip）',
            '  --alipay-password <p> 支付宝账单解压密码（或用环境变量 HIFIN_ALIPAY_PASSWORD）',
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
  if (!a.alipayPassword) {
    throw new Error(
      '缺少支付宝账单解压密码：请用 --alipay-password <p> 传入，或设置环境变量 HIFIN_ALIPAY_PASSWORD',
    );
  }
  return a;
}

/* ── 账单原件 → 逐行溯源字段 ────────────────────────────────────── */

/** 一条账单原件行（已规整成"要落库的形状"） */
interface BillRow {
  /** 匹配键 */
  key: string;
  source: string;
  externalId: string | null;
  paymentMethod: string | null;
  status: string | null;
  /** 微信「交易类型」/ 支付宝「交易分类」原文 */
  billCategory: string;
  /** 解析出的收支方向；excluded/transfer 表示这笔不是收支 */
  dir: string;
  amount: number;
  date: number;
  merchant: string;
  remark: string | null;
}

function matchKey(accountId: number, amount: number, date: number, name: string): string {
  // 金额统一 toFixed(2)：消掉 SQLite REAL 与 JS number 之间的浮点尾差
  return `${accountId}|${amount.toFixed(2)}|${date}|${name}`;
}

/** 平台占位符 "/"：两家账单用它表示"这格没内容" */
function blank(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  if (!t || t === '/') return null;
  return t;
}

/**
 * app 的 ParsedTx → BillRow。
 *
 * **不过滤 type**：零钱通那些行在账单里 type='excluded'（收/支列是 "/"），
 * 而本脚本要回答的恰恰是"有没有 0 笔这样的行混进了库里"，先把它们收进来
 * 才能在后面反查时给出确定答案。真正写库时仍然只碰匹配上的行。
 */
function rowsFromParse(
  items: Array<Record<string, unknown>>,
  platform: string,
  accountId: number,
): BillRow[] {
  const source = normalizeSource(platform);
  const out: BillRow[] = [];
  for (const raw of items) {
    const it = raw as {
      date: number;
      amount: number;
      type: string;
      merchant: string;
      remark?: string;
      billCategory?: string;
      externalId?: string;
      paymentMethod?: string;
      status?: string;
      rawLine?: string;
    };
    if (it.rawLine || !it.date || !it.amount) continue;
    const merchant = it.merchant || '账单导入';
    out.push({
      key: matchKey(accountId, it.amount, it.date, merchant),
      source,
      externalId: blank(it.externalId),
      // 组合支付取 & 前段：解析层已经规整过，这里只做空值兜底
      paymentMethod: blank(it.paymentMethod),
      status: blank(it.status),
      billCategory: (it.billCategory ?? '').trim(),
      dir: it.type,
      amount: it.amount,
      date: it.date,
      merchant,
      remark: blank(it.remark),
    });
  }
  return out;
}

function parseAlipay(path: string, password: string, accountId: number): BillRow[] {
  const files = unzipBill(path, password);
  try {
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
    return rowsFromParse(parsed.items as unknown as Array<Record<string, unknown>>, 'alipay', accountId);
  } finally {
    // 解压出的临时目录跟 unzipBill 一样挂在 hifin-bill- 前缀下
    const root = tempRootOf(files);
    if (root) cleanupBillDir(root);
  }
}

function parseWechat(path: string, accountId: number): BillRow[] {
  const text = xlsxToCsvText(path);
  const parsed = parseCsvText(text, 'wechat');
  return rowsFromParse(parsed.items as unknown as Array<Record<string, unknown>>, 'wechat', accountId);
}

/** 与 importer.ts 的 tempRootOf 同一套逻辑：从解出的文件反推临时根目录 */
function tempRootOf(files: string[]): string {
  let dir = files[0] ? pathDirname(files[0]) : '';
  for (let i = 0; i < 16 && dir && pathDirname(dir) !== dir; i++) {
    if (pathBasename(dir).startsWith('hifin-bill-')) return dir;
    dir = pathDirname(dir);
  }
  return '';
}

/* ── 主流程 ────────────────────────────────────────────────── */

function pct(n: number, total: number): string {
  return total === 0 ? '0%' : `${((n / total) * 100).toFixed(1)}%`;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const db = new Database(args.db);
  // REST 服务（:8787）可能正连着同一个库；WAL 下并发读没问题，
  // 但拿不到写锁时要等一会儿而不是立刻 SQLITE_BUSY
  db.pragma('busy_timeout = 10000');

  console.log('═'.repeat(72));
  console.log('hifin 存量交易字段回填（source / externalId / paymentMethod / status）');
  console.log('═'.repeat(72));
  console.log(`数据库      : ${args.db}`);
  console.log(`支付宝账单  : ${args.alipay}`);
  console.log(`微信账单    : ${args.wechat}`);
  console.log(`模式        : ${args.apply ? 'APPLY（会写库）' : 'DRY-RUN（只读，不写库）'}`);
  console.log('');

  // ── 0. schema 就位 ──
  // 之所以由脚本兜底而不是要求调用方先手动跑一次，是因为回填写的就是新列——
  // 列不存在时后面每条 UPDATE 都会失败，报错还很难指向真正的原因。
  //
  // dry-run **绝不能**在这里写库：migrate() 会 ALTER TABLE。所以只读地看一眼
  // 现状并如实报告，把建列留给 --apply。
  const versionBefore = getUserVersion(db);
  const colsBefore = new Set(getColumns(db, 'transactions'));
  const NEW_COLUMNS = ['source', 'externalId', 'paymentMethod', 'status'] as const;
  const missingCols = NEW_COLUMNS.filter((c) => !colsBefore.has(c));

  console.log(`schema      : user_version ${versionBefore}（当前 ${CURRENT_SCHEMA_VERSION}）`);
  if (missingCols.length === 0) {
    console.log('             溯源四列已就位');
  } else {
    console.log(`             ⚠ 缺列：${missingCols.join('、')}`);
    console.log(
      args.apply
        ? '             --apply 模式下会先自动补列 + 建部分唯一索引'
        : '             dry-run 不写库；加 --apply 时会自动补列 + 建部分唯一索引',
    );
  }
  console.log('');

  // ── 1. 定位账单所属账户 ──
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

  // ── 2. 解析账单原件 ──
  const aliRows = parseAlipay(args.alipay, args.alipayPassword, accountId);
  const wxRows = parseWechat(args.wechat, accountId);
  const allRows = [...aliRows, ...wxRows];

  // key → 所有同键原件行。同一四元组可能有多行（导入时会被去重吞掉一部分），
  // 所以这里存数组而不是单条，后面按"方向是否相同"挑最贴的那条。
  const index = new Map<string, BillRow[]>();
  for (const r of allRows) {
    const arr = index.get(r.key);
    if (arr) arr.push(r);
    else index.set(r.key, [r]);
  }

  const ioRows = (rows: BillRow[]) => rows.filter((r) => r.dir === 'expense' || r.dir === 'income');
  console.log(
    `账单原件    ：支付宝 ${aliRows.length} 行（其中收支 ${ioRows(aliRows).length}）/ ` +
      `微信 ${wxRows.length} 行（其中收支 ${ioRows(wxRows).length}）`,
  );
  console.log(`唯一四元组  ：${index.size} 个`);
  console.log('');

  /**
   * 挑一条最贴的原件行：先要方向相同的（收/支是强信号），
   * 再退而求其次取第一条。同键多行时（导入时被去重的那批），
   * 它们的字段值可能不同，所以这里必须给确定性。
   */
  const pick = (key: string, type: string): BillRow | null => {
    const cands = index.get(key);
    if (!cands || cands.length === 0) return null;
    return cands.find((c) => c.dir === type) ?? cands[0];
  };

  // ── 3. 扫待回填交易 ──
  interface TxRow {
    id: number;
    name: string;
    amount: number;
    date: number;
    type: string;
    accountId: number;
    remark: string | null;
    source: string | null;
    externalId: string | null;
  }
  /**
   * 扫描列按"列是否已存在"动态拼。
   *
   * dry-run 跑在**未升级**的老库上是常态（这正是要先看报告再决定要不要写的原因），
   * 写死 SELECT source 会在报表还没打出来之前就先崩在 no such column 上，
   * 什么信息都留不下。
   */
  const extraCols = (['source', 'externalId'] as const).filter((c) => colsBefore.has(c));
  const targets = db
    .prepare(
      `SELECT id, name, amount, date, type, accountId, remark${extraCols.length ? ', ' + extraCols.join(', ') : ''}
         FROM transactions ORDER BY id`,
    )
    .all() as TxRow[];
  const scanned = args.limit === null ? targets : targets.slice(0, args.limit);

  const plan: Array<{
    id: number;
    source: string;
    externalId: string | null;
    paymentMethod: string | null;
    status: string | null;
    bill: BillRow;
  }> = [];
  const unmatched: TxRow[] = [];
  /** 同一四元组在不同平台都出现了 —— 说明匹配键不足以唯一确定来源 */
  const crossSource: Array<{ id: number; key: string; sources: string[] }> = [];
  const changed = new Set<string>(); // 已有值的字段（重跑时会被跳过，但仍要报告）

  for (const t of scanned) {
    const key = matchKey(t.accountId, t.amount, t.date, t.name);
    const cands = index.get(key);
    if (!cands) {
      unmatched.push(t);
      continue;
    }
    const sources = [...new Set(cands.map((c) => c.source))];
    if (sources.length > 1) {
      crossSource.push({ id: t.id, key, sources });
      continue;
    }
    const bill = pick(key, t.type)!;
    /**
     * 只有"本来就有值、且和账单对不上"才值得报警。
     *
     * 注意用 ?? null 兜一层：老库上这两列压根不存在，SELECT 没查它们，
     * 取到的是 undefined 而不是 null。`undefined !== null` 为真，
     * 直接判会被当成"库里已有值且对不上"，于是首跑时 817 行全被误报成冲突。
     */
    const curSource = t.source ?? null;
    const curExt = t.externalId ?? null;
    if (
      (curSource !== null && curSource !== bill.source) ||
      (curExt !== null && curExt !== bill.externalId)
    ) {
      changed.add(`#${t.id} ${curSource ?? '-'}/${curExt ?? '-'} → ${bill.source}/${bill.externalId ?? '-'}`);
    }
    plan.push({
      id: t.id,
      source: bill.source,
      externalId: bill.externalId,
      paymentMethod: bill.paymentMethod,
      status: bill.status,
      bill,
    });
  }

  // ── 4. 报告：溯源四件套 ──
  const bySource = new Map<string, number>();
  const extMissing: number[] = [];
  for (const p of plan) {
    bySource.set(p.source, (bySource.get(p.source) ?? 0) + 1);
    if (!p.externalId) extMissing.push(p.id);
  }
  console.log('─'.repeat(72));
  console.log('① 溯源四件套回填');
  console.log('─'.repeat(72));
  console.log(`可匹配交易  ：${plan.length} / ${scanned.length}  ${pct(plan.length, scanned.length)}`);
  for (const s of ['wechat', 'alipay', 'csv']) {
    const n = bySource.get(s);
    if (n === undefined) continue;
    const label = s === 'wechat' ? '微信 wechat ' : s === 'alipay' ? '支付宝 alipay' : '其它  csv   ';
    console.log(`  ${label} ${String(n).padStart(3)} 笔`);
  }
  console.log(`缺 externalId：${extMissing.length} 笔${extMissing.length ? ` → ${extMissing.slice(0, 10).join(', ')}` : ''}`);
  console.log(`跨平台同键    ：${crossSource.length} 笔${crossSource.length ? '（匹配键不唯一，已跳过，需人工确认）' : ''}`);
  if (unmatched.length > 0) {
    console.log(`匹配不上      ：${unmatched.length} 笔，样例：`);
    for (const t of unmatched.slice(0, 8)) {
      console.log(
        `    #${t.id} ${new Date(t.date).toISOString().slice(0, 19).replace('T', ' ')} ` +
          `${t.type} ${t.amount} 「${t.name}」`,
      );
    }
  } else {
    console.log('匹配不上      ：0 笔 ✔');
  }
  if (changed.size > 0) {
    console.log(`⚠ 与库中已有值不一致（重跑时会覆盖，共 ${changed.size} 笔）：`);
    for (const c of [...changed].slice(0, 8)) console.log(`    ${c}`);
  }
  console.log('');

  // ── 5. 报告：remark 清理 ──
  const slashRemark = db
    .prepare("SELECT id FROM transactions WHERE remark = '/' ORDER BY id")
    .all() as Array<{ id: number }>;
  console.log('─'.repeat(72));
  console.log('② remark = "/" 清理（平台占位符，不是真的备注）');
  console.log('─'.repeat(72));
  console.log(`待清理行数    ：${slashRemark.length}`);
  console.log('');

  // ── 6. 报告：零钱通划转 type 修正 ──
  const lqtPlan: Array<{ id: number; type: string; amount: number; name: string; billCategory: string }> = [];
  const lqtBillRows = allRows.filter((r) => isWechatInternalTransfer(r.billCategory));
  for (const t of scanned) {
    const key = matchKey(t.accountId, t.amount, t.date, t.name);
    const cands = index.get(key);
    if (!cands) continue;
    const hit = cands.find((c) => isWechatInternalTransfer(c.billCategory));
    if (hit) {
      lqtPlan.push({
        id: t.id,
        type: t.type,
        amount: t.amount,
        name: t.name,
        billCategory: hit.billCategory,
      });
    }
  }
  const lqtToFix = lqtPlan.filter((r) => r.type === 'expense' || r.type === 'income');

  console.log('─'.repeat(72));
  console.log('③ 零钱通账户内部划转 type 修正');
  console.log('─'.repeat(72));
  console.log(`账单里的零钱通行：${lqtBillRows.length} 笔（转入 ${lqtBillRows.filter((r) => r.billCategory.startsWith('转入零钱通')).length} / 转出 ${lqtBillRows.filter((r) => r.billCategory.startsWith('零钱通转出')).length}）`);
  console.log(`  它们在账单里的「收/支」列是 "/" → 解析层给出 'excluded' → 导入器直接丢弃，`);
  console.log(`  所以**本来就没进 transactions**。下面这一行是在核对这个前提：`);
  console.log(`库中匹配到的零钱通交易：${lqtPlan.length} 笔，其中 income/expense 需修正 ${lqtToFix.length} 笔`);
  if (lqtToFix.length === 0) {
    console.log('✔ 无需修正：库里没有把账户内部划转误记成 income/expense 的行，余额无需调整');
  } else {
    for (const r of lqtToFix.slice(0, 10)) {
      console.log(`    #${r.id} ${r.type} ${r.amount} 「${r.name}」 ← ${r.billCategory}`);
    }
  }
  console.log('');

  if (!args.apply) {
    console.log('─'.repeat(72));
    console.log('DRY-RUN 结束：以上均为计划，未写入任何数据。加 --apply 执行。');
    console.log('─'.repeat(72));
    db.close();
    return;
  }

  // ── 7. 落库 ──
  console.log('─'.repeat(72));
  console.log('写入中…');
  console.log('─'.repeat(72));

  // 补列/建索引必须在任何 UPDATE 之前。
  // 走 migrate() 而不是手搓 ALTER：migrate 还会把 user_version 推到 2，
  // 手搓的话库里有新列、版本号却还停在 1，之后谁看 PRAGMA 都会判断错。
  if (missingCols.length > 0) {
    const before2 = getUserVersion(db);
    migrate(db);
    console.log(`schema 升级：user_version ${before2} → ${getUserVersion(db)}`);
    for (const c of missingCols) console.log(`  ALTER TABLE transactions ADD COLUMN ${c} TEXT`);
    console.log('  (部分唯一索引 idx_tx_source_external 已就位)');
    console.log('');
  }

  const before = balanceSnapshot(db);
  const updFields = db.prepare(
    `UPDATE transactions
        SET source = ?, externalId = ?, paymentMethod = ?, status = ?
      WHERE id = ?`,
  );
  const updSlash = db.prepare("UPDATE transactions SET remark = NULL WHERE remark = '/'");
  /**
   * type 修正一步到位：'excluded' + 备注追加后缀。
   * 后缀追加放在 SQL 里做幂等（已带后缀就不再加），免得脚本重跑一次
   * 备注就变成"（账户内部划转）（账户内部划转）"。
   */
  const updType = db.prepare(
    `UPDATE transactions
        SET type = 'excluded',
            remark = CASE
              WHEN remark IS NULL OR remark = '' THEN ?
              WHEN remark LIKE '%' || ? THEN remark
              ELSE remark || ' ' || ?
            END
      WHERE id = ?`,
  );
  const updBalance = db.prepare('UPDATE accounts SET balance = balance + ?, updatedAt = ? WHERE id = ?');

  const written = db.transaction(() => {
    let n = 0;
    for (const p of plan) {
      n += updFields.run(p.source, p.externalId, p.paymentMethod, p.status, p.id).changes;
    }
    const slash = updSlash.run().changes;
    // 余额反向调整：原来 income 让余额 +amount、expense 让余额 -amount，
    // 改成 excluded 后这两个 ±amount 都不该再存在，所以原样加回去
    let fixed = 0;
    for (const r of lqtToFix) {
      updType.run(TRANSFER_REMARK_SUFFIX, TRANSFER_REMARK_SUFFIX, TRANSFER_REMARK_SUFFIX, r.id).changes;
      const delta = r.type === 'income' ? -r.amount : r.amount;
      updBalance.run(delta, Date.now(), accountId);
      fixed++;
    }
    return { fields: n, slash, fixed };
  })();

  // 备注追加单独做：上面先把 remark 置空，这里按"原备注 + 后缀"补回去
  if (lqtToFix.length > 0) {
    const appendRemark = db.prepare(
      `UPDATE transactions
          SET remark = CASE
            WHEN remark IS NULL OR remark = '' THEN ?
            WHEN remark LIKE '%' || ? THEN remark
            ELSE remark || ' ' || ?
          END
        WHERE id = ?`,
    );
    db.transaction(() => {
      for (const r of lqtToFix) appendRemark.run(TRANSFER_REMARK_SUFFIX, TRANSFER_REMARK_SUFFIX, TRANSFER_REMARK_SUFFIX, r.id);
    })();
  }

  const after = balanceSnapshot(db);

  console.log(`UPDATE source/externalId/paymentMethod/status：${written.fields} 行`);
  console.log(`UPDATE remark='/' → NULL                    ：${written.slash} 行`);
  console.log(`零钱通 type → 'excluded'                    ：${written.fixed} 行`);
  console.log('');

  // ── 8. 余额不变量 ──
  console.log('─'.repeat(72));
  console.log('④ 余额与不变量');
  console.log('─'.repeat(72));
  console.log(`账户 #${accountId} 余额：${before.balance.toFixed(2)} → ${after.balance.toFixed(2)}  （差额 ${(after.balance - before.balance).toFixed(2)}）`);
  console.log('');
  console.log('验证 SQL：');
  console.log(
    '  SELECT a.id, ROUND(a.balance,2) AS balance, ROUND(COALESCE(SUM(CASE WHEN t.type=\'income\' THEN t.amount ELSE 0 END - CASE WHEN t.type=\'expense\' THEN t.amount ELSE 0 END),0),2) AS expected',
  );
  console.log('  FROM accounts a LEFT JOIN transactions t ON t.accountId=a.id AND t.includeInAsset=1');
  console.log('  GROUP BY a.id;');
  for (const row of after.perAccount) {
    const ok = Math.abs(row.balance - row.expected) < 1e-6;
    console.log(
      `  account ${row.id}  balance=${row.balance.toFixed(2)}  expected=${row.expected.toFixed(2)}  ${ok ? '✔' : '✘'}`,
    );
  }
  if (!after.invariantOk) process.exitCode = 1;
  console.log('');

  // ── 9. 分布校验 ──
  console.log('─'.repeat(72));
  console.log('⑤ 回填后分布');
  console.log('─'.repeat(72));
  const dist = db
    .prepare("SELECT source, COUNT(*) c FROM transactions GROUP BY source ORDER BY c DESC")
    .all() as Array<{ source: string | null; c: number }>;
  for (const d of dist) {
    const label = d.source ?? '(NULL)';
    console.log(`  source=${label.padEnd(8)} ${String(d.c).padStart(4)} 笔`);
  }
  const w = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE source='wechat'").get() as { c: number }).c;
  const a = (db.prepare("SELECT COUNT(*) c FROM transactions WHERE source='alipay'").get() as { c: number }).c;
  console.log('');
  console.log(`期望 wechat 500 / alipay 317 → 实际 wechat ${w} / alipay ${a}  ${w === 500 && a === 317 ? '✔' : '✘'}`);
  if (!(w === 500 && a === 317)) process.exitCode = 1;

  const dup = db
    .prepare(
      `SELECT source, externalId, COUNT(*) c FROM transactions
        WHERE externalId IS NOT NULL GROUP BY source, externalId HAVING c > 1`,
    )
    .all() as Array<{ source: string; externalId: string; c: number }>;
  console.log(`(source, externalId) 重复组：${dup.length}${dup.length ? ' ✘' : ' ✔'}`);
  if (dup.length > 0) process.exitCode = 1;

  const stillSlash = (
    db.prepare("SELECT COUNT(*) c FROM transactions WHERE remark = '/'").get() as { c: number }
  ).c;
  console.log(`残留 remark='/' 行数：${stillSlash}${stillSlash === 0 ? ' ✔' : ' ✘'}`);
  if (stillSlash !== 0) process.exitCode = 1;
  console.log('');

  db.close();
}

interface BalanceRow {
  id: number;
  balance: number;
  expected: number;
}
interface BalanceSnapshot {
  balance: number;
  perAccount: BalanceRow[];
  invariantOk: boolean;
}

/** 抓账户余额 + 按不变量算出的应有余额 */
function balanceSnapshot(db: Database.Database): BalanceSnapshot {
  const perAccount = db
    .prepare(
      `SELECT a.id AS id, a.balance AS balance,
              COALESCE(SUM(CASE WHEN t.type='income' THEN t.amount ELSE 0 END
                           - CASE WHEN t.type='expense' THEN t.amount ELSE 0 END), 0) AS expected
         FROM accounts a
         LEFT JOIN transactions t ON t.accountId = a.id AND t.includeInAsset = 1
        GROUP BY a.id ORDER BY a.id`,
    )
    .all() as BalanceRow[];
  const target = perAccount.find((r) => r.id === 1) ?? perAccount[0];
  return {
    balance: target ? target.balance : 0,
    perAccount,
    invariantOk: perAccount.every((r) => Math.abs(r.balance - r.expected) < 1e-6),
  };
}

main();
