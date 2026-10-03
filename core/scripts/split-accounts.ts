/**
 * 多账户分流（纯库内操作：不改 core/src、不改 app/）
 * =================================================================
 * 改造前：817 笔账单流水全挂 accountId=1（现金），余额 -28,237.09；资产分布图
 * 只有一根柱子。账单本身其实带足了「收/付款方式」，升级后的管道
 * （src/bill/account-map.ts + src/bill/importer.ts）能把它收敛成 7 个账户名，
 * 但**库里已有的 817 笔不会自己搬家**——本脚本补上这一段。
 *
 * 四步（dry-run 与 --apply 跑的是同一段代码，区别只在跑在快照还是真库上，
 * 所以 dry-run 的每个数字都可以直接当成 apply 的结果看）：
 *   1. 建 7 个账户（同名则复用），记下 名称 → id 的分流表
 *   2. 按 paymentMethod 把已有流水重挂到目标账户，并**按流水分摊余额**
 *   3. 用升级后的 import 管道重导两份原件：externalId 去重自动跳过 817 笔，
 *      只补回当初被丢掉的划转/还款行
 *   4. 出推算余额表 + 全量校验
 *
 * 余额口径（本脚本最需要解释的一处）
 * -----------------------------------------------------------------
 * 账户余额不是"搬"出来的，是**按流水净额重新校准**出来的：
 *     账户余额 = Σ收入 − Σ支出 − Σ划转出 + Σ划转入
 * 之所以敢这么做，是因为 817 笔的净额恰好等于原现金账户的余额（分毫不差），
 * 于是"每账户余额 == 其名下流水净额"与"Σ全部账户余额 == -28,237.09"两条要求
 * 可以同时成立，不必把某一笔钱的差额偷偷摊到别的账户头上。
 * 万一出现差额（理论上不会：金额都是两位小数），差额会**原样**记在兜底账户
 * 「现金」上并在报告里报出来，绝不悄悄抹平。
 *
 * 用法
 *   npx tsx scripts/split-accounts.ts --alipay-password <密码>            # dry-run
 *   npx tsx scripts/split-accounts.ts --apply --alipay-password <密码>   # 落库
 *
 * 密码只从命令行参数读，既不落盘也不打印（--help 里也不会复述它）。
 */

import type Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db/connection.js';
import { importBillZip, type ImportBillResult } from '../src/bill/importer.js';
import { ACCOUNT_NAMES, ACCOUNT_TYPES, ALL_ACCOUNT_NAMES, resolveAccountName } from '../src/bill/account-map.js';
import type { AccountMap } from '../src/mail/importer.js';

// ── CLI ──────────────────────────────────────────────────────────

interface Options {
  apply: boolean;
  dbPath: string;
  alipayZip: string;
  alipayPassword: string;
  wechatXlsx: string;
  /** 保留重导时冒出来的非划转新行（默认剔除，见 step 3 的说明） */
  allowExtra: boolean;
  skipImport: boolean;
  keepSnapshot: string;
}

const DEFAULT_DB = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'hifin.db');
const DEFAULT_ALIPAY_ZIP = '/tmp/check-alipay.zip';
const DEFAULT_WECHAT_XLSX = '/tmp/check-wechat.xlsx';

/**
 * 微信那一步的占位密码。
 *
 * 手上只有**已解压的 xlsx**，而 importBillZip 的入口是 ZIP。现场把 xlsx 原样
 * 装进一个不加密的临时 ZIP（字节与原件一致），让同一条管道原封不动跑一遍。
 * adm-zip 只对**加密条目**使用密码（node_modules/adm-zip/zipEntry.js 的
 * `_centralHeader.encrypted` 分支），未加密包会把这个占位串直接忽略——
 * core/tests/transfer-accounts.test.ts 的 writePlainZip 是同一手法。
 * 它不是任何真实密码，也不会被写进任何文件。
 */
const WECHAT_CONTAINER_PASSWORD = 'unencrypted-xlsx';

function parseArgs(argv: string[]): Options {
  const o: Options = {
    apply: false,
    dbPath: DEFAULT_DB,
    alipayZip: DEFAULT_ALIPAY_ZIP,
    alipayPassword: '',
    wechatXlsx: DEFAULT_WECHAT_XLSX,
    allowExtra: false,
    skipImport: false,
    keepSnapshot: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} 缺少取值`);
      return v;
    };
    switch (a) {
      case '--apply': o.apply = true; break;
      case '--db': o.dbPath = resolve(next()); break;
      case '--alipay-zip': o.alipayZip = resolve(next()); break;
      case '--alipay-password': o.alipayPassword = next(); break;
      case '--wechat-xlsx': o.wechatXlsx = resolve(next()); break;
      case '--allow-extra': o.allowExtra = true; break;
      case '--skip-import': o.skipImport = true; break;
      case '--keep-snapshot': o.keepSnapshot = resolve(next()); break;
      case '--help':
      case '-h':
        console.log(
          [
            '多账户分流脚本（默认 dry-run，不写真库）',
            '',
            '  --apply               真正落库（不加就是 dry-run，跑在临时快照上）',
            '  --db <path>           数据库路径（默认 core/data/hifin.db）',
            '  --alipay-zip <path>   支付宝原件 ZIP（默认 /tmp/check-alipay.zip）',
            '  --alipay-password <p> 支付宝解压密码（只从命令行读，不落盘/不打印）',
            '  --wechat-xlsx <path>  微信原件 xlsx（默认 /tmp/check-wechat.xlsx）',
            '  --allow-extra         保留重导时冒出来的非划转新行（默认剔除）',
            '  --skip-import         只做分流与余额，不重导原件',
            '  --keep-snapshot <p>   dry-run 后把快照库保留到指定路径',
          ].join('\n'),
        );
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${a}（--help 看用法）`);
    }
  }
  return o;
}

// ── 小工具 ───────────────────────────────────────────────────────

/** 金额一律按「分」做整数运算：避免浮点累加把 0.01 的账算丢 */
const toCents = (x: number): number => Math.round(x * 100);
const fmt = (cents: number): string => (cents / 100).toFixed(2);

/** CJK / 全角字符按 2 列宽算，不然表格在等宽字体下会歪 */
const WIDE = /[ᄀ-ᅟ⺀-鿿가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
function padEndW(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, width - w));
}
function padStartW(s: string, width: number): string {
  let w = 0;
  for (const ch of s) w += WIDE.test(ch) ? 2 : 1;
  return ' '.repeat(Math.max(0, width - w)) + s;
}
const ymd = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

// ── 结构 ─────────────────────────────────────────────────────────

interface AccountInfo {
  name: string;
  type: string;
  wantType: string;
  id: number;
  created: boolean;
  typeOk: boolean;
  balanceBefore: number;
}

interface NetStat {
  income: number;
  expense: number;
  out: number;
  in: number;
  net: number;
  incomeN: number;
  expenseN: number;
  outN: number;
  inN: number;
}

interface SplitGroup {
  paymentMethod: string;
  account: string;
  count: number;
  income: number;
  expense: number;
  net: number;
}

interface NewRow {
  id: number;
  type: string;
  name: string;
  amount: number;
  date: number;
  accountId: number;
  toAccountId: number | null;
  categoryId: number | null;
  source: string | null;
  externalId: string | null;
  paymentMethod: string | null;
  status: string | null;
}

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

interface Report {
  accounts: AccountInfo[];
  nameOf: (id: number) => string;
  splitGroups: SplitGroup[];
  movedRows: number;
  nets: Map<number, NetStat>;
  totalBefore: number;
  residual: number;
  txCountBefore: number;
  imports: Array<{ platform: string; result: ImportBillResult }>;
  addedTransfers: NewRow[];
  removedExtra: NewRow[];
  /** 导入管道自己联动出来的余额（分），用来和"按流水净额"的口径互相对照 */
  balanceFromPipeline: Map<number, number>;
  checks: Check[];
}

// ── 1. 账户 ──────────────────────────────────────────────────────

function stepEnsureAccounts(db: Database.Database): { accounts: AccountInfo[]; map: AccountMap } {
  const existing = db.prepare('SELECT id, name, type, balance FROM accounts ORDER BY id').all() as Array<{
    id: number;
    name: string;
    type: string;
    balance: number;
  }>;
  const now = Date.now();
  const ins = db.prepare(
    `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (?, ?, 0, 1, 1, ?, ?)`,
  );
  const accounts: AccountInfo[] = [];
  const map: Record<string, number> = {};

  for (const name of ALL_ACCOUNT_NAMES) {
    const wantType = ACCOUNT_TYPES[name] ?? 'fund';
    /**
     * 同名即复用。账户名是 account-map 产出的唯一契约，重建一个同名账户等于
     * 让同一批流水的归属凭空分叉成两份；而"现金"本来就存在（id=1，
     * 余额 -28,237.09），它是这套设计的兜底账户，必须是同一个。
     */
    const hit = existing.find((a) => a.name === name);
    if (hit) {
      accounts.push({
        name,
        type: hit.type,
        wantType,
        id: hit.id,
        created: false,
        typeOk: hit.type === wantType,
        balanceBefore: toCents(hit.balance),
      });
      map[name] = hit.id;
      continue;
    }
    const info = ins.run(name, wantType, now, now);
    const id = Number(info.lastInsertRowid);
    accounts.push({ name, type: wantType, wantType, id, created: true, typeOk: true, balanceBefore: 0 });
    map[name] = id;
  }
  return { accounts, map };
}

// ── 2. 分流 ──────────────────────────────────────────────────────

/** 读全部流水，算每个账户侧的净额（分）。转出侧记 −，toAccountId 侧记 +。 */
function computeNets(db: Database.Database): Map<number, NetStat> {
  const rows = db
    .prepare('SELECT type, amount, accountId, toAccountId FROM transactions')
    .all() as Array<{ type: string; amount: number; accountId: number; toAccountId: number | null }>;
  const nets = new Map<number, NetStat>();
  const slot = (id: number): NetStat => {
    let v = nets.get(id);
    if (!v) {
      v = { income: 0, expense: 0, out: 0, in: 0, net: 0, incomeN: 0, expenseN: 0, outN: 0, inN: 0 };
      nets.set(id, v);
    }
    return v;
  };
  for (const r of rows) {
    const c = toCents(r.amount);
    const s = slot(r.accountId);
    if (r.type === 'income') {
      s.income += c; s.incomeN += 1; s.net += c;
    } else if (r.type === 'expense') {
      s.expense += c; s.expenseN += 1; s.net -= c;
    } else if (r.type === 'transfer') {
      s.out += c; s.outN += 1; s.net -= c;
      if (r.toAccountId !== null && r.toAccountId !== r.accountId) {
        const t = slot(r.toAccountId);
        t.in += c; t.inN += 1; t.net += c;
      }
    }
  }
  return nets;
}

function stepSplit(db: Database.Database, map: AccountMap): { groups: SplitGroup[]; moved: number } {
  const rows = db
    .prepare('SELECT id, type, amount, paymentMethod, source, accountId FROM transactions ORDER BY id')
    .all() as Array<{
    id: number;
    type: string;
    amount: number;
    paymentMethod: string | null;
    source: string | null;
    accountId: number;
  }>;

  const upd = db.prepare('UPDATE transactions SET accountId = ? WHERE id = ?');
  const groups = new Map<string, SplitGroup>();
  let moved = 0;

  db.transaction(() => {
    for (const r of rows) {
      /**
       * 划转行已经带着两端的 accountId（导入管道落的），不能按 paymentMethod 重挂：
       * 它的 paymentMethod 说的是"转出时用的渠道"，只对转出侧成立。
       */
      if (r.type === 'transfer') continue;
      const accountName = resolveAccountName(r.paymentMethod, r.source ?? undefined);
      const target = map[accountName];
      if (target === undefined) throw new Error(`分流表里没有账户「${accountName}」`);
      const c = toCents(r.amount);
      const key = r.paymentMethod ?? '（无支付方式）';
      const g = groups.get(key) ?? { paymentMethod: key, account: accountName, count: 0, income: 0, expense: 0, net: 0 };
      g.count += 1;
      if (r.type === 'income') { g.income += c; g.net += c; } else { g.expense += c; g.net -= c; }
      groups.set(key, g);
      if (target !== r.accountId) {
        upd.run(target, r.id);
        moved += 1;
      }
    }
  })();

  return { groups: [...groups.values()].sort((a, b) => b.count - a.count || a.account.localeCompare(b.account)), moved };
}

/** 按流水净额重新校准余额；与原余额的差额原样记在兜底账户「现金」上 */
function calibrateBalances(db: Database.Database, accounts: AccountInfo[], totalBeforeCents: number): number {
  const nets = computeNets(db);
  const now = Date.now();
  const upd = db.prepare('UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?');
  const target = new Map<number, number>();
  let sum = 0;
  for (const a of accounts) {
    const net = nets.get(a.id)?.net ?? 0;
    target.set(a.id, net);
    sum += net;
  }
  const residual = totalBeforeCents - sum;
  const fallback = accounts.find((a) => a.name === ACCOUNT_NAMES.fallback);
  if (residual !== 0 && fallback) target.set(fallback.id, (target.get(fallback.id) ?? 0) + residual);
  db.transaction(() => {
    for (const a of accounts) upd.run((target.get(a.id) ?? 0) / 100, now, a.id);
  })();
  return residual;
}

// ── 3. 重导原件 ──────────────────────────────────────────────────

interface ImportOutcome {
  imports: Array<{ platform: string; result: ImportBillResult }>;
  added: NewRow[];
  /** 导入管道自己算出来的余额（分），用来和"按流水净额"的口径对照 */
  balanceFromPipeline: Map<number, number>;
}

async function stepImportBills(db: Database.Database, o: Options, map: AccountMap): Promise<ImportOutcome> {
  const fallbackId = map[ACCOUNT_NAMES.fallback];
  const imports: Array<{ platform: string; result: ImportBillResult }> = [];
  const maxIdBefore = (db.prepare('SELECT COALESCE(MAX(id), 0) m FROM transactions').get() as { m: number }).m;

  if (!o.skipImport) {
    if (!o.alipayPassword) {
      throw new Error('重导支付宝原件需要解压密码：请用 --alipay-password <密码> 传入（只从命令行读，不落盘）');
    }
    if (existsSync(o.alipayZip)) {
      const alipay = await importBillZip(db, o.alipayZip, 'alipay', o.alipayPassword, fallbackId, 1, undefined, map);
      imports.push({ platform: 'alipay', result: alipay });
    } else {
      throw new Error(`支付宝原件不存在：${o.alipayZip}`);
    }
    if (existsSync(o.wechatXlsx)) {
      const tmpDir = mkdtempSync(join(tmpdir(), 'hifin-xlsx-'));
      try {
        const zipPath = join(tmpDir, 'wechat-bill.zip');
        const zip = new AdmZip();
        zip.addFile(basename(o.wechatXlsx), readFileSync(o.wechatXlsx));
        zip.writeZip(zipPath);
        const wechat = await importBillZip(db, zipPath, 'wechat', WECHAT_CONTAINER_PASSWORD, fallbackId, 1, undefined, map);
        imports.push({ platform: 'wechat', result: wechat });
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    }
  }

  const added = db
    .prepare(
      `SELECT id, type, name, amount, date, accountId, toAccountId, categoryId,
              source, externalId, paymentMethod, status
         FROM transactions WHERE id > ? ORDER BY id`,
    )
    .all(maxIdBefore) as NewRow[];

  const balanceFromPipeline = new Map<number, number>(
    (db.prepare('SELECT id, balance FROM accounts').all() as Array<{ id: number; balance: number }>).map((a) => [
      a.id,
      toCents(a.balance),
    ]),
  );
  return { imports, added, balanceFromPipeline };
}

// ── 4. 主体 ──────────────────────────────────────────────────────

async function runAll(db: Database.Database, o: Options): Promise<Report> {
  const totalBeforeCents = toCents(
    (db.prepare('SELECT COALESCE(SUM(balance), 0) s FROM accounts').get() as { s: number }).s,
  );
  const txCountBefore = (db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c;

  const { accounts, map } = db.transaction(() => stepEnsureAccounts(db))();
  const split = db.transaction(() => stepSplit(db, map))();
  const residual = calibrateBalances(db, accounts, totalBeforeCents);

  const imp = await stepImportBills(db, o, map);

  /**
   * 重导时冒出来的**非划转**新行，默认剔除。
   *
   * 本次重导的目的是"把当初被丢掉的划转/还款行补回来"，不是补录漏账。实测
   * 支付宝原件里有 1 笔花呗消费在账上根本没有对应记录（金额 39.35，见报告），
   * 一并留下就会凭空改掉花呗余额与支出统计——那是本次任务范围之外的账目变更，
   * 该由用户决定补不补。所以默认剔除并逐行列在报告里；确实要留下就加
   * --allow-extra。
   */
  const extra = imp.added.filter((r) => r.type !== 'transfer');
  const addedTransfers = imp.added.filter((r) => r.type === 'transfer');
  let removedExtra: NewRow[] = [];
  if (extra.length > 0 && !o.allowExtra) {
    const del = db.prepare('DELETE FROM transactions WHERE id = ?');
    db.transaction(() => {
      for (const r of extra) del.run(r.id);
    })();
    removedExtra = extra;
  }
  // 删完再校准一次：删除会动余额，而"余额 == 流水净额"这条不变量必须由校准
  // 兜住，不能指望 DELETE 语句自己算对
  calibrateBalances(db, accounts, totalBeforeCents);

  const nets = computeNets(db);
  const nameOf = (id: number): string => accounts.find((a) => a.id === id)?.name ?? `#${id}`;

  return {
    accounts,
    nameOf,
    splitGroups: split.groups,
    movedRows: split.moved,
    nets,
    totalBefore: totalBeforeCents,
    residual,
    txCountBefore,
    imports: imp.imports,
    addedTransfers,
    removedExtra,
    balanceFromPipeline: imp.balanceFromPipeline,
    checks: buildChecks(db, accounts, map, {
      totalBeforeCents,
      txCountBefore,
      addedCount: imp.added.length,
      transferCount: addedTransfers.length,
      removedCount: removedExtra.length,
      nets,
      balanceFromPipeline: imp.balanceFromPipeline,
    }),
  };
}

interface CheckCtx {
  totalBeforeCents: number;
  txCountBefore: number;
  addedCount: number;
  transferCount: number;
  removedCount: number;
  nets: Map<number, NetStat>;
  balanceFromPipeline: Map<number, number>;
}

function buildChecks(db: Database.Database, accounts: AccountInfo[], map: AccountMap, ctx: CheckCtx): Check[] {
  const out: Check[] = [];
  const add = (name: string, pass: boolean, detail: string): void => {
    out.push({ name, pass, detail });
  };
  const one = <T>(sql: string, ...args: unknown[]): T => db.prepare(sql).get(...(args as [])) as T;
  const count = (sql: string, ...args: unknown[]): number => (one<{ c: number }>(sql, ...args)).c;
  const sum = (sql: string, ...args: unknown[]): number => one<{ s: number }>(sql, ...args).s;

  // 1. 总笔数：只允许"新增 − 剔除"，不允许凭空少或多
  const total = count('SELECT COUNT(*) c FROM transactions');
  const expect = ctx.txCountBefore + ctx.addedCount - ctx.removedCount;
  add('总笔数 = 原笔数 + 新增 − 剔除', total === expect,
    `${ctx.txCountBefore} + ${ctx.addedCount} − ${ctx.removedCount} = ${expect}，实际 ${total}`);

  // 2. Σ余额不变，且分毫不差
  const sumBal = toCents(sum('SELECT COALESCE(SUM(balance), 0) s FROM accounts'));
  add('Σ全部账户余额 == -28,237.09（分毫不差）', sumBal === ctx.totalBeforeCents && sumBal === -2823709,
    `Σ=${fmt(sumBal)}（改前 ${fmt(ctx.totalBeforeCents)}）`);

  // 3. 每账户余额 == 名下流水净额
  const bad: string[] = [];
  for (const a of accounts) {
    const bal = toCents(one<{ balance: number }>('SELECT balance FROM accounts WHERE id = ?', a.id).balance);
    const net = ctx.nets.get(a.id)?.net ?? 0;
    if (bal !== net) bad.push(`${a.name} 余额${fmt(bal)}≠净额${fmt(net)}`);
  }
  add('每账户余额 == 名下流水净额', bad.length === 0, bad.length === 0 ? `${accounts.length}/${accounts.length} 一致` : bad.join('; '));

  // 4. type 违例
  const catViol = count(
    'SELECT COUNT(*) c FROM transactions t JOIN categories c ON c.id = t.categoryId WHERE c.type <> t.type',
  );
  const txOnTransfer = count("SELECT COUNT(*) c FROM transactions WHERE type='transfer' AND categoryId IS NOT NULL");
  const badAccType = count(
    "SELECT COUNT(*) c FROM accounts WHERE type NOT IN ('fund','asset','social','invest','other','credit','debt')",
  );
  const badTxType = count("SELECT COUNT(*) c FROM transactions WHERE type NOT IN ('expense','income','transfer','excluded')");
  add('type 违例 = 0', catViol === 0 && txOnTransfer === 0 && badAccType === 0 && badTxType === 0,
    `分类方向违例 ${catViol} / 划转带分类 ${txOnTransfer} / 非法账户类型 ${badAccType} / 非法流水类型 ${badTxType}`);

  // 5. 划转双边对称
  const orphan = count("SELECT COUNT(*) c FROM transactions WHERE type='transfer' AND toAccountId IS NULL");
  const selfTx = count("SELECT COUNT(*) c FROM transactions WHERE type='transfer' AND toAccountId = accountId");
  const outSum = toCents(sum("SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='transfer'"));
  const inSum = toCents(sum(
    "SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE type='transfer' AND toAccountId IS NOT NULL AND toAccountId <> accountId",
  ));
  add('划转双边金额对称', orphan === 0 && selfTx === 0 && outSum === inSum,
    `转出合计 ${fmt(outSum)} == 转入合计 ${fmt(inSum)}；孤儿划转 ${orphan}；自转 ${selfTx}`);

  // 6. 未标明支付方式的流水全落现金
  const blank = "(paymentMethod IS NULL OR TRIM(paymentMethod) = '' OR paymentMethod = '/')";
  const blankTotal = count(`SELECT COUNT(*) c FROM transactions WHERE ${blank}`);
  const blankNotCash = count(`SELECT COUNT(*) c FROM transactions WHERE ${blank} AND accountId <> ?`, map[ACCOUNT_NAMES.fallback]);
  add('未标明支付方式的流水全落「现金」', blankNotCash === 0, `共 ${blankTotal} 笔，越界 ${blankNotCash} 笔`);

  // 7. 流水不指向不存在的账户
  const orphanTx = count(
    'SELECT COUNT(*) c FROM transactions t LEFT JOIN accounts a ON a.id = t.accountId WHERE a.id IS NULL',
  );
  const orphanTo = count(
    'SELECT COUNT(*) c FROM transactions t LEFT JOIN accounts a ON a.id = t.toAccountId WHERE t.toAccountId IS NOT NULL AND a.id IS NULL',
  );
  add('流水不指向不存在的账户', orphanTx === 0 && orphanTo === 0, `accountId 悬空 ${orphanTx} / toAccountId 悬空 ${orphanTo}`);

  // 8. externalId 无重复
  const dupExt = count(
    `SELECT COUNT(*) c FROM (SELECT source, externalId FROM transactions
      WHERE externalId IS NOT NULL AND externalId <> ''
      GROUP BY source, externalId HAVING COUNT(*) > 1)`,
  );
  add('(source, externalId) 无重复', dupExt === 0, `重复组 ${dupExt}`);

  // 9. 账户集合齐备
  const accCount = count('SELECT COUNT(*) c FROM accounts');
  const missing = ALL_ACCOUNT_NAMES.filter((n) => !accounts.some((a) => a.name === n));
  const typeMismatch = accounts.filter((a) => !a.typeOk);
  add('设计账户齐备且 type 一致', missing.length === 0 && typeMismatch.length === 0,
    `库内 ${accCount} 个账户；缺失 ${missing.length === 0 ? '无' : missing.join('、')}；type 不一致 ${typeMismatch.length === 0 ? '无' : typeMismatch.map((a) => a.name).join('、')}`);

  /**
   * 10. 导入管道自己联动出来的余额 == 按流水净额算出来的余额。
   *
   * 这是对"划转双边联动"最硬的交叉验证：本脚本的余额是**从流水反推**的，
   * 管道那边的余额是**导入时逐条加减**的，两条互不相干的路径算出同一个数，
   * 才说明"转出减、对端加"没写反、没漏。
   * 有非划转新行被剔除时，管道算的是剔除前的账，数字本来就该差一截——
   * 那时这条校验只报告不判定。
   */
  if (ctx.balanceFromPipeline.size > 0) {
    const diff: string[] = [];
    for (const a of accounts) {
      const pipe = ctx.balanceFromPipeline.get(a.id);
      if (pipe === undefined) continue;
      const net = ctx.nets.get(a.id)?.net ?? 0;
      if (pipe !== net) diff.push(`${a.name} 管道 ${fmt(pipe)}≠推算 ${fmt(net)}`);
    }
    add(
      '导入管道联动余额 == 流水推算余额',
      diff.length === 0,
      diff.length === 0
        ? `${accounts.length}/${accounts.length} 一致${ctx.removedCount > 0 ? '（本次剔除过非划转新行，管道算的是剔除前的账，此处只作参考）' : ''}`
        : diff.join('; '),
    );
  }

  return out;
}

// ── 报告 ─────────────────────────────────────────────────────────

function printReport(r: Report, o: Options, snapshot: string): void {
  const line = (s = ''): void => console.log(s);
  line('='.repeat(84));
  line(`多账户分流 · ${o.apply ? 'APPLY（写真库）' : 'DRY-RUN（跑在临时快照上，真库未被触碰）'}`);
  line(`数据库：${o.dbPath}`);
  if (!o.apply) line(`快照：  ${snapshot}${o.keepSnapshot ? '（--keep-snapshot 保留）' : '（跑完即删）'}`);
  line('='.repeat(84));

  // 1 账户
  line('\n【1】账户');
  line(`  ${padEndW('账户名', 14)}${padEndW('type', 8)}${padStartW('id', 4)}  ${padEndW('来源', 6)}${padStartW('收支笔', 8)}${padStartW('划转出', 8)}${padStartW('划转入', 8)}${padStartW('推算余额', 14)}`);
  for (const a of r.accounts) {
    const n = r.nets.get(a.id);
    const cnt = r.splitGroups.filter((g) => g.account === a.name).reduce((s, g) => s + g.count, 0);
    line(
      `  ${padEndW(a.name, 14)}${padEndW(a.type, 8)}${padStartW(String(a.id), 4)}  ${padEndW(a.created ? '新建' : '复用', 6)}` +
      `${padStartW(String(cnt), 8)}${padStartW(String(n?.outN ?? 0), 8)}${padStartW(String(n?.inN ?? 0), 8)}` +
      `${padStartW(fmt(n?.net ?? 0), 14)}` + (a.typeOk ? '' : `  ⚠️ 既有 type=${a.type}，设计为 ${a.wantType}`),
    );
  }

  // 2 分流
  line('\n【2】按支付方式分流（paymentMethod 原文 → 目标账户）');
  line(`  ${padEndW('paymentMethod', 30)}${padEndW('→ 账户', 14)}${padStartW('笔数', 6)}${padStartW('收入', 12)}${padStartW('支出', 12)}${padStartW('净额', 13)}`);
  for (const g of r.splitGroups) {
    line(`  ${padEndW(g.paymentMethod, 30)}${padEndW(g.account, 14)}${padStartW(String(g.count), 6)}${padStartW(fmt(g.income), 12)}${padStartW(fmt(g.expense), 12)}${padStartW(fmt(g.net), 13)}`);
  }
  const totalCnt = r.splitGroups.reduce((s, g) => s + g.count, 0);
  line(`  ${padEndW('合计', 30)}${padEndW('', 14)}${padStartW(String(totalCnt), 6)}  （实际 UPDATE transactions ${r.movedRows} 行）`);

  // 3 余额
  line('\n【3】余额迁移（每账户余额 = 名下流水净额）');
  const fallback = r.accounts.find((a) => a.name === ACCOUNT_NAMES.fallback);
  line(`  分流前 Σ余额：${fmt(r.totalBefore)}（其中原「${fallback?.name ?? '现金'}」账户 ${fmt(fallback?.balanceBefore ?? 0)}）`);
  line(`  校准后 Σ余额：${fmt(r.totalBefore)}`);
  line(
    r.residual === 0
      ? '  分流净额与原余额分毫不差，无需把任何差额摊到「现金」'
      : `  ⚠️ 流水净额与原余额差 ${fmt(r.residual)}，已原样记在「现金」上`,
  );

  // 4 新增划转
  line('\n【4】重导原件 · 新增划转');
  for (const im of r.imports) {
    const res = im.result;
    const bits = [`新增 ${res.imported} 行`, `跳过 ${res.skipped} 行`];
    if (res.selfTransfers) bits.push(`其中自转 ${res.selfTransfers} 行（归并后自己转自己，本就不该记）`);
    if (res.unmappedTransfers && Object.keys(res.unmappedTransfers).length > 0) {
      bits.push(`⚠️ 对端账户缺失 ${JSON.stringify(res.unmappedTransfers)}`);
    }
    line(`  ${im.platform}：${bits.join('，')}`);
  }
  const routeMap = new Map<string, { count: number; cents: number }>();
  let routeTotal = 0;
  for (const t of r.addedTransfers) {
    const key = `${r.nameOf(t.accountId)} → ${t.toAccountId === null ? '(无对端)' : r.nameOf(t.toAccountId)}`;
    const st = routeMap.get(key) ?? { count: 0, cents: 0 };
    st.count += 1;
    st.cents += toCents(t.amount);
    routeMap.set(key, st);
    routeTotal += toCents(t.amount);
  }
  if (routeMap.size === 0) {
    line('  （本次没有新增划转）');
  } else {
    line(`  路线汇总（共 ${r.addedTransfers.length} 笔 · 转出合计 ${fmt(routeTotal)} = 转入合计 ${fmt(routeTotal)}）：`);
    for (const [key, st] of routeMap) {
      line(`    ${padEndW(key, 40)}${padStartW(String(st.count), 6)} 笔${padStartW(fmt(st.cents), 14)}`);
    }
  }
  if (r.addedTransfers.length > 0) {
    line(`\n  逐笔明细：`);
    line(`  ${padStartW('id', 5)}  ${padEndW('日期', 12)}${padStartW('金额', 10)}  ${padEndW('转出', 12)}${padEndW('转入', 12)}${padEndW('来源', 8)}${padEndW('摘要/原文', 24)}${padEndW('单号', 26)}`);
    for (const t of r.addedTransfers) {
      line(
        `  ${padStartW(String(t.id), 5)}  ${padEndW(ymd(t.date), 12)}${padStartW(fmt(toCents(t.amount)), 10)}  ` +
        `${padEndW(r.nameOf(t.accountId), 12)}${padEndW(t.toAccountId === null ? '(无对端)' : r.nameOf(t.toAccountId), 12)}` +
        `${padEndW(t.source ?? '', 8)}${padEndW(t.name, 24)}${padEndW(t.externalId ?? '', 26)}`,
      );
    }
  }
  if (r.removedExtra.length > 0) {
    line('\n  ⚠️ 剔除的非划转新增行（重导冒出来、但属本任务范围外的账目变更；加 --allow-extra 可保留）：');
    for (const t of r.removedExtra) {
      line(
        `  ${padStartW(String(t.id), 5)}  ${padEndW(ymd(t.date), 12)}${padStartW(fmt(toCents(t.amount)), 10)}  ` +
        `${padEndW(r.nameOf(t.accountId), 12)}${padEndW(`${t.type} ${t.name}`, 32)}${padEndW(t.externalId ?? '', 26)}`,
      );
    }
  }

  // 5 推算余额表
  line('\n【5】推算余额表（校准用）');
  line(`  ${padEndW('账户', 14)}${padStartW('收入', 12)}${padStartW('支出', 12)}${padStartW('划转出', 12)}${padStartW('划转入', 12)}${padStartW('推算余额', 14)}${padStartW('库内余额', 14)}${padStartW('管道余额', 14)}`);
  let sumNet = 0;
  for (const a of r.accounts) {
    const n = r.nets.get(a.id) ?? { income: 0, expense: 0, out: 0, in: 0, net: 0, incomeN: 0, expenseN: 0, outN: 0, inN: 0 };
    sumNet += n.net;
    const bal = n.net + (a.name === ACCOUNT_NAMES.fallback ? r.residual : 0);
    const pipe = r.balanceFromPipeline.get(a.id);
    line(`  ${padEndW(a.name, 14)}${padStartW(fmt(n.income), 12)}${padStartW(fmt(n.expense), 12)}${padStartW(fmt(n.out), 12)}${padStartW(fmt(n.in), 12)}${padStartW(fmt(n.net), 14)}${padStartW(fmt(bal), 14)}${padStartW(pipe === undefined ? '' : fmt(pipe), 14)}`);
  }
  line(`  ${padEndW('合计', 14)}${padStartW('', 12)}${padStartW('', 12)}${padStartW('', 12)}${padStartW('', 12)}${padStartW(fmt(sumNet), 14)}${padStartW(fmt(sumNet + r.residual), 14)}`);

  // 6 校验
  line('\n【6】校验');
  for (const c of r.checks) line(`  ${c.pass ? '✅' : '❌'} ${padEndW(c.name, 32)} ${c.detail}`);
  const failed = r.checks.filter((c) => !c.pass);
  line('');
  line(
    failed.length === 0
      ? `全部 ${r.checks.length} 项校验通过。${o.apply ? '已落库。' : '尚未落库：确认无误后加 --apply 重跑。'}`
      : `⚠️ ${failed.length}/${r.checks.length} 项未通过：${failed.map((f) => f.name).join('、')}`,
  );
}

// ── 入口 ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const real = openDatabase(o.dbPath);
  // 与 :8787 的 REST 服务共用同一个库文件，WAL 下并发写要排队，给足等待时间
  real.pragma('busy_timeout = 15000');

  let snapshotPath = '';
  let snapshotDir = '';
  let target = real;
  if (!o.apply) {
    snapshotDir = mkdtempSync(join(tmpdir(), 'hifin-split-dry-'));
    snapshotPath = o.keepSnapshot || join(snapshotDir, 'hifin.db');
    mkdirSync(dirname(snapshotPath), { recursive: true });
    /**
     * 用 SQLite 自己的 backup API 取一致快照：直接拷 .db 文件会在 WAL 里还有
     * 未 checkpoint 的内容时拷出一个缺行的库，dry-run 的数字就全错了。
     */
    await real.backup(snapshotPath);
    target = openDatabase(snapshotPath);
    target.pragma('busy_timeout = 15000');
  }

  let failed = false;
  try {
    const report = await runAll(target, o);
    printReport(report, o, snapshotPath);
    failed = report.checks.some((c) => !c.pass);
  } finally {
    if (!o.apply) {
      if (o.keepSnapshot) console.log(`\n（--keep-snapshot：快照保留在 ${o.keepSnapshot}）`);
      else rmSync(snapshotDir, { recursive: true, force: true });
    }
    if (target !== real) target.close();
    real.close();
  }
  if (failed) process.exit(2);
}

main().catch((e: unknown) => {
  console.error('❌ 执行失败：', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
