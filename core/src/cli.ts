/**
 * hifin CLI 入口 — commander 程序
 *
 * 子命令：
 *   serve [--port]
 *   accounts list [--space N]
 *   accounts add --name X --type fund --balance 0
 *   tx list [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--type expense]
 *   tx add --type expense --amount 38 --name X [--accountId N] [--date ISO]
 *   summary [--month YYYY-MM]
 *   import-csv <file> --platform alipay --accountId N
 *   import-bill <zipPath> --platform alipay|wechat [--password xxx] --accountId N [--space N]
 *   mail config --host imap.qq.com --port 993 --user x@qq.com --password **** [--tls true]
 *   mail config --show
 *   mail poll [--days 7] --accountId N
 *
 * 所有子命令默认输出 JSON；加 --human 后用 console.table。
 *
 * CLI 直接操作 SQLite（通过 src/db/connection.ts），不走 HTTP。
 * 但 import-csv 是复用 app/src/features/transactions/csv.ts 的解析器（tsx 运行时解析）。
 * import-bill 在此之上多一步 ZIP 解压（见 src/bill/），密码默认按平台内置。
 */
import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  openDatabase,
} from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureSeed } from './db/seed.js';
import { getDb, setActiveDb } from './routes/_db.js';
import {
  loadMailConfig,
  readMaskedMailConfig,
  runMailPoll,
  saveMailConfig,
} from './mail/poller.js';
import { importBillZip } from './bill/importer.js';
import type {
  AccountRow,
  TransactionRow,
  TransactionType,
  AccountType,
} from './db/schema.js';

const DEFAULT_DB =
  process.env.HIFIN_DB_PATH ?? '/home/saltedfish/project/hifin/core/data/hifin.db';

function ensureDb(dbPath: string): void {
  const db = openDatabase(dbPath);
  setActiveDb(db);
  migrate(db);
  ensureSeed(db);
}

function printHumanTable(rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('(empty)');
    return;
  }
  // console.table 是 Node 自带，输出对齐表格
  // eslint-disable-next-line no-console
  console.table(rows);
}

function emit(value: unknown, human: boolean): void {
  if (human) {
    const arr = Array.isArray(value) ? (value as Record<string, unknown>[]) : [value as Record<string, unknown>];
    printHumanTable(arr);
  } else {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(value, null, 2));
  }
}

function dayjsParseToTs(input: string): number {
  // 支持 YYYY-MM-DD、ISO、毫秒戳
  if (/^\d+$/.test(input)) return Number(input);
  const ts = Date.parse(input);
  if (!Number.isNaN(ts)) return ts;
  // YYYY-MM-DD 兜底（用本地 00:00:00）
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  }
  throw new Error(`无法解析日期: ${input}`);
}

function parseBool(v: string, flag: string): boolean {
  if (/^(true|1|yes|on)$/i.test(v)) return true;
  if (/^(false|0|no|off)$/i.test(v)) return false;
  throw new Error(`${flag} 必须是 true/false，收到: ${v}`);
}

const program = new Command();
program
  .name('hifin')
  .description('HiFin 核心 CLI')
  .option('--db <path>', 'SQLite 文件路径', DEFAULT_DB)
  .option('--human', '人类可读输出（表格）', false);

// ── serve ────────────────────────────────────────────────
program
  .command('serve')
  .description('启动 REST 服务')
  .option('--port <n>', '监听端口', String(Number(process.env.PORT) || 8787))
  .action(async (opts: { port: string }) => {
    const port = Number(opts.port);
    const { createApp } = await import('./server.js');
    const app = createApp({ dbPath: program.opts().db });
    app.listen(port, () => {
      // eslint-disable-next-line no-console
      console.log(`[hifin] serve on http://127.0.0.1:${port}`);
    });
  });

// ── accounts ─────────────────────────────────────────────
const accounts = program.command('accounts').description('账户操作');

accounts
  .command('list')
  .description('列出账户')
  .option('--space <n>', '按 spaceId 过滤')
  .action((opts: { space?: string }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    let rows: AccountRow[];
    if (opts.space !== undefined) {
      rows = db
        .prepare('SELECT * FROM accounts WHERE spaceId = ? ORDER BY id ASC')
        .all(Number(opts.space)) as AccountRow[];
    } else {
      rows = db
        .prepare('SELECT * FROM accounts ORDER BY id ASC')
        .all() as AccountRow[];
    }
    emit(rows, !!program.opts().human);
  });

accounts
  .command('add')
  .description('创建账户')
  .requiredOption('--name <name>', '账户名')
  .requiredOption('--type <type>', '类型 (fund/asset/social/invest/other/credit/debt)')
  .option('--balance <n>', '初始余额', '0')
  .option('--remark <text>', '备注')
  .option('--includeInNetAsset <flag>', '是否计入净资产 (true/false)', 'true')
  .option('--space <n>', '空间 ID', '1')
  .action((opts: {
    name: string;
    type: string;
    balance: string;
    remark?: string;
    includeInNetAsset: string;
    space: string;
  }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    const ts = Date.now();
    const result = db
      .prepare(
        `INSERT INTO accounts (name, type, balance, remark, tagIds, includeInNetAsset, spaceId, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.name,
        opts.type,
        Number(opts.balance),
        opts.remark ?? null,
        null,
        opts.includeInNetAsset === 'true' ? 1 : 0,
        Number(opts.space),
        ts,
        ts,
      );
    const row = db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(result.lastInsertRowid) as AccountRow;
    emit(row, !!program.opts().human);
  });

// ── tx ───────────────────────────────────────────────────
const tx = program.command('tx').description('交易操作');

tx
  .command('list')
  .description('列出交易')
  .option('--from <date>', '起始日期 YYYY-MM-DD 或 ISO')
  .option('--to <date>', '结束日期 YYYY-MM-DD 或 ISO')
  .option('--type <type>', '按类型过滤 (expense/income/transfer/excluded)')
  .option('--accountId <n>', '按账户过滤')
  .option('--space <n>', '按 spaceId 过滤')
  .action((opts: {
    from?: string;
    to?: string;
    type?: string;
    accountId?: string;
    space?: string;
  }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.from) {
      where.push('date >= ?');
      params.push(dayjsParseToTs(opts.from));
    }
    if (opts.to) {
      where.push('date <= ?');
      params.push(dayjsParseToTs(opts.to));
    }
    if (opts.type) {
      where.push('type = ?');
      params.push(opts.type);
    }
    if (opts.accountId) {
      where.push('(accountId = ? OR toAccountId = ?)');
      params.push(Number(opts.accountId), Number(opts.accountId));
    }
    if (opts.space) {
      where.push('spaceId = ?');
      params.push(Number(opts.space));
    }
    const sql = `SELECT * FROM transactions ${
      where.length ? 'WHERE ' + where.join(' AND ') : ''
    } ORDER BY date DESC, id DESC`;
    const rows = db.prepare(sql).all(...params) as TransactionRow[];
    emit(rows, !!program.opts().human);
  });

tx
  .command('add')
  .description('创建交易（自动联动账户余额）')
  .requiredOption('--type <type>', '类型 (expense/income/transfer/excluded)')
  .requiredOption('--amount <n>', '金额（正数）')
  .requiredOption('--name <name>', '交易名')
  .option('--accountId <n>', '账户 ID')
  .option('--toAccountId <n>', '转入账户 ID（transfer 必填）')
  .option('--categoryId <n>', '分类 ID')
  .option('--date <iso>', '日期（YYYY-MM-DD / ISO）', new Date().toISOString())
  .option('--remark <text>', '备注')
  .option('--space <n>', '空间 ID', '1')
  .action((opts: {
    type: string;
    amount: string;
    name: string;
    accountId?: string;
    toAccountId?: string;
    categoryId?: string;
    date: string;
    remark?: string;
    space: string;
  }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    const type = opts.type as TransactionType;
    const amount = Number(opts.amount);
    const accountId = Number(opts.accountId);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('--amount 必须为正数');
    }
    if (!Number.isFinite(accountId)) {
      throw new Error('--accountId 必填且必须为数字');
    }
    const date = dayjsParseToTs(opts.date);
    const toAccountId =
      opts.toAccountId !== undefined ? Number(opts.toAccountId) : null;
    if (type === 'transfer') {
      if (toAccountId === null) {
        throw new Error('transfer 类型必须指定 --toAccountId');
      }
      if (toAccountId === accountId) {
        throw new Error('toAccountId 不能等于 accountId');
      }
    }
    const result = db.transaction(() => {
      const r = db
        .prepare(
          `INSERT INTO transactions
            (type, name, amount, date, categoryId, accountId, toAccountId, remark, tagIds, merchantId, includeInAsset, spaceId, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          type,
          opts.name,
          amount,
          date,
          opts.categoryId !== undefined ? Number(opts.categoryId) : null,
          accountId,
          toAccountId,
          opts.remark ?? null,
          null,
          null,
          1,
          Number(opts.space),
          Date.now(),
        );
      // 余额联动
      const acc = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as
        | AccountRow
        | undefined;
      if (acc) {
        const delta = type === 'income' ? amount : type === 'expense' ? -amount : type === 'transfer' ? -amount : 0;
        db.prepare('UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?').run(
          acc.balance + delta,
          Date.now(),
          accountId,
        );
      }
      if (type === 'transfer' && toAccountId !== null) {
        const to = db
          .prepare('SELECT * FROM accounts WHERE id = ?')
          .get(toAccountId) as AccountRow | undefined;
        if (to) {
          db.prepare('UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?').run(
            to.balance + amount,
            Date.now(),
            toAccountId,
          );
        }
      }
      return r.lastInsertRowid;
    })();
    const row = db
      .prepare('SELECT * FROM transactions WHERE id = ?')
      .get(result) as TransactionRow;
    emit(row, !!program.opts().human);
  });

// ── summary ──────────────────────────────────────────────
program
  .command('summary')
  .description('汇总（净资产 + 月度收支 + 环比）')
  .option('--month <YYYY-MM>', '月份（默认当月）')
  .action((opts: { month?: string }) => {
    const month =
      opts.month ??
      (() => {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      })();
    ensureDb(program.opts().db);
    const db = getDb();
    const m = /^(\d{4})-(\d{2})$/.exec(month);
    if (!m) throw new Error('--month 必须是 YYYY-MM');
    const start = new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
    const end = new Date(Number(m[1]), Number(m[2]), 1).getTime();

    const accounts = db.prepare('SELECT * FROM accounts').all() as AccountRow[];
    let asset = 0;
    let debt = 0;
    for (const a of accounts) {
      if (!a.includeInNetAsset) continue;
      if (a.type === 'credit' || a.type === 'debt') debt += Math.abs(a.balance);
      else asset += a.balance;
    }
    const netAsset = asset - debt;

    const txs = db
      .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
      .all(start, end) as TransactionRow[];
    let monthIncome = 0;
    let monthExpense = 0;
    for (const t of txs) {
      if (t.includeInAsset === 0) continue;
      if (t.type === 'income') monthIncome += t.amount;
      else if (t.type === 'expense') monthExpense += t.amount;
    }
    const monthNet = monthIncome - monthExpense;

    let prevNet = 0;
    let momDelta = 0;
    let momDeltaPct: number | null = null;
    {
      const y = Number(m[1]);
      const mo = Number(m[2]) - 1;
      let py = y;
      let pmo = mo;
      if (pmo === 0) { py -= 1; pmo = 12; }
      const pStart = new Date(py, pmo - 1, 1).getTime();
      const pEnd = new Date(py, pmo, 1).getTime();
      const ptx = db
        .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
        .all(pStart, pEnd) as TransactionRow[];
      for (const t of ptx) {
        if (t.includeInAsset === 0) continue;
        if (t.type === 'income') prevNet += t.amount;
        else if (t.type === 'expense') prevNet -= t.amount;
      }
      momDelta = monthNet - prevNet;
      if (prevNet !== 0) momDeltaPct = (momDelta / Math.abs(prevNet)) * 100;
    }

    emit(
      {
        month,
        netAsset,
        monthIncome,
        monthExpense,
        monthNet,
        mom: { delta: momDelta, deltaPct: momDeltaPct },
      },
      !!program.opts().human,
    );
  });

// ── import-csv ───────────────────────────────────────────
program
  .command('import-csv <file>')
  .description('从 CSV 导入交易（复用 app/src/features/transactions/csv.ts）')
  .requiredOption('--platform <id>', '平台 (alipay/wechat/...)')
  .requiredOption('--accountId <n>', '导入到哪个账户')
  .option('--space <n>', '空间 ID', '1')
  .action(async (file: string, opts: { platform: string; accountId: string; space: string }) => {
    const filePath = resolve(file);
    // 动态 import：tsx 运行时解析；tsc 不会跨 rootDir 校验 @/db 别名
    // 用 import.meta.url 解析到项目根，避免相对路径在 ESM 中基于当前模块解析
    const csvUrl = new URL('../../app/src/features/transactions/csv.ts', import.meta.url).href;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(csvUrl);
    // T7：readFileSync(path,'utf8') 硬编码 + 无前言剥离，真实支付宝导出（GBK+前言）
    // 走此路径 100% 丢光（valid=0）；改读字节走共享 decodeBillBytes（UTF-8 优先探测 +
    // GBK 回退 + 前言剥离），与 app 上传路径/core 管道同口径
    const decodeBillBytes = mod.decodeBillBytes as (buf: ArrayBuffer) => string;
    const raw = readFileSync(filePath);
    // Buffer 的 .buffer 可能是共享内存池且带 byteOffset，必须切片成精确视图
    const text = decodeBillBytes(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    );
    const parseCsvText = mod.parseCsvText as (
      text: string,
      platformHint?: string,
    ) => {
      platform: string;
      total: number;
      valid: number;
      items: Array<{
        date: number;
        amount: number;
        type: TransactionType;
        merchant: string;
        remark?: string;
        rawLine?: string;
      }>;
      error?: string;
    };
    const result = parseCsvText(text, opts.platform);

    ensureDb(program.opts().db);
    const db = getDb();
    const accountId = Number(opts.accountId);
    const account = db
      .prepare('SELECT * FROM accounts WHERE id = ?')
      .get(accountId) as AccountRow | undefined;
    if (!account) throw new Error(`账户 ${accountId} 不存在`);
    const spaceId = Number(opts.space);

    const inserted: TransactionRow[] = [];
    const skipped: Array<{ rawLine?: string; reason: string }> = [];
    db.transaction(() => {
      for (const item of result.items) {
        if (item.rawLine || !item.date || !item.amount || item.type === 'excluded') {
          skipped.push({ rawLine: item.rawLine, reason: '解析失败或已排除' });
          continue;
        }
        const r = db
          .prepare(
            `INSERT INTO transactions
              (type, name, amount, date, categoryId, accountId, toAccountId, remark, tagIds, merchantId, includeInAsset, spaceId, createdAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            item.type,
            item.merchant || '导入',
            item.amount,
            item.date,
            null,
            accountId,
            null,
            item.remark ?? null,
            null,
            null,
            1,
            spaceId,
            Date.now(),
          );
        const tx = db
          .prepare('SELECT * FROM transactions WHERE id = ?')
          .get(r.lastInsertRowid) as TransactionRow;
        inserted.push(tx);
        // 余额联动
        const acc = db
          .prepare('SELECT * FROM accounts WHERE id = ?')
          .get(accountId) as AccountRow;
        const delta =
          item.type === 'income' ? item.amount : item.type === 'expense' ? -item.amount : 0;
        db.prepare('UPDATE accounts SET balance = ?, updatedAt = ? WHERE id = ?').run(
          acc.balance + delta,
          Date.now(),
          accountId,
        );
      }
    })();

    emit(
      {
        platform: result.platform,
        total: result.total,
        valid: result.valid,
        inserted: inserted.length,
        skipped: skipped.length,
        items: inserted,
        error: result.error,
      },
      !!program.opts().human,
    );
  });

// ── import-bill ────────────────────────────────────────────
/**
 * 账单 ZIP 导入。
 * 邮件账单是通知型的，流水在加密 ZIP 附件里；这里一步走完
 * "解压 → 找 CSV → 解析 → 入库"，解析器与前端共用（app/.../csv.ts）。
 */
program
  .command('import-bill <zipPath>')
  .description('解压账单 ZIP 并导入（密码每次申请都不同，请看最新账单邮件/短信）')
  .requiredOption('--platform <id>', '平台 (alipay/wechat)')
  .requiredOption('--accountId <n>', '导入到哪个账户')
  .requiredOption('--password <pw>', '解压密码（每次申请账单时不同，必填）')
  .option('--space <n>', '空间 ID', '1')
  .action(async (zipPath: string, opts: { platform: string; accountId: string; password: string; space: string }) => {
    const filePath = resolve(zipPath);

    ensureDb(program.opts().db);
    const db = getDb();
    const accountId = Number(opts.accountId);
    const account = db.prepare('SELECT id FROM accounts WHERE id = ?').get(accountId) as
      | { id: number }
      | undefined;
    if (!account) throw new Error(`账户 ${accountId} 不存在`);

    const result = await importBillZip(
      db,
      filePath,
      opts.platform,
      opts.password,
      accountId,
      Number(opts.space),
    );

    emit(
      {
        platform: result.platform,
        imported: result.imported,
        skipped: result.skipped,
        files: result.files.map((f) => basename(f)),
      },
      !!program.opts().human,
    );
  });

// ── mail ─────────────────────────────────────────────────
/**
 * 邮箱账单导入。
 * 凭证存 kv 表：非敏感字段在 mail.config（JSON），密码单独存 mail.password，
 * 因此 `mail config --show` 与任何 config 视图都不会泄露明文密码。
 */
const mail = program.command('mail').description('邮箱账单导入（IMAP）');

mail
  .command('config')
  .description('写入 IMAP 凭证；--show 查看当前配置（密码打码）')
  .option('--host <host>', 'IMAP 服务器地址（首次必填）')
  .option('--port <n>', 'IMAP 端口', (v) => Number(v))
  .option('--user <email>', '登录账号（首次必填）')
  .option('--password <pw>', '登录密码 / 授权码（首次必填；省略则保留已存密码）')
  .option('--tls <flag>', '是否启用 TLS (true/false)', (v) => parseBool(v, '--tls'))
  .option('--mailbox <name>', '邮箱目录', 'INBOX')
  .option('--show', '显示当前配置（密码打码 ******）', false)
  .action((opts: {
    host?: string;
    port?: number;
    user?: string;
    password?: string;
    tls?: boolean;
    mailbox?: string;
    show?: boolean;
  }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    if (opts.show) {
      const view = readMaskedMailConfig(db);
      emit(view ? { configured: true, ...view } : { configured: false }, !!program.opts().human);
      return;
    }
    const view = saveMailConfig(db, {
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      tls: opts.tls,
      mailbox: opts.mailbox,
    });
    emit({ configured: true, ...view }, !!program.opts().human);
  });

mail
  .command('poll')
  .description('拉取最近 N 天的未读邮件，解析并导入交易')
  .option('--days <n>', '拉取最近多少天', (v) => Number(v), 7)
  .requiredOption('--accountId <n>', '导入到哪个账户', (v) => Number(v))
  .option('--space <n>', '空间 ID', (v) => Number(v), 1)
  .option('--bill-password-alipay <pw>', '支付宝账单解压密码（一次性，仅本次有效）')
  .option('--bill-password-wechat <pw>', '微信账单解压密码（一次性，仅本次有效）')
  .action(async (opts: { days: number; accountId: number; space: number; billPasswordAlipay?: string; billPasswordWechat?: string }) => {
    ensureDb(program.opts().db);
    const db = getDb();
    const config = loadMailConfig(db);
    if (!config) {
      throw new Error(
        '尚未配置邮箱，请先执行: hifin mail config --host imap.qq.com --user xxx@qq.com --password ****',
      );
    }
    const summary = await runMailPoll(db, {
      config,
      days: opts.days,
      accountId: opts.accountId,
      spaceId: opts.space,
      billPasswords: {
        ...(opts.billPasswordAlipay ? { alipay: opts.billPasswordAlipay } : {}),
        ...(opts.billPasswordWechat ? { wechat: opts.billPasswordWechat } : {}),
      },
      // 账单提示走 stderr：stdout 保持纯 JSON，方便脚本 pipe 给 jq
      onBill: (o) => {
        if (o.status === 'no-attachment' && o.hint) {
          // eslint-disable-next-line no-console
          console.error(`[hifin] ${o.subject} — ${o.hint}`);
        } else if (o.status === 'imported') {
          // eslint-disable-next-line no-console
          console.error(`[hifin] ${o.subject} — 已从附件导入 ${o.imported} 笔`);
        } else if (o.status === 'error') {
          // eslint-disable-next-line no-console
          console.error(`[hifin] ${o.subject} — 附件导入失败：${o.message}`);
        }
      },
    });
    emit(summary, !!program.opts().human);
  });

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[hifin] error:', err?.message ?? err);
  process.exit(1);
});
