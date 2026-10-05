/**
 * hifin MCP server — stdio transport，给 Claude Code / Cursor 等 host 用。
 *
 * 设计依据 docs/mcp-design.md §5：11 个 tool，handler 与 transport 解耦，
 * 全是纯函数 (args) => Promise<{ content }>。stdio 入口在 cli.ts mcp 子命令里。
 *
 * 复用（按 docs/mcp-design.md §8 引用速查）：
 *   - monthRange / calcNetAsset / sumTx (routes/summary.ts 导出)
 *   - listNotifications (notifications/store.ts)
 *   - importBillZip (bill/importer.ts)
 *   - runMailPoll / loadMailConfig (mail/poller.ts)
 *   - setBillPassword (bill/password-store.ts)
 *   - 其余 5 个只读工具是 5~10 行内联 SQL，参考 routes/*.ts 同口径；
 *     不抽 routes handler、不增加新抽象（ponytail 阶梯第 5/7 阶）。
 */
import type Database from 'better-sqlite3';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type {
  AccountRow,
  CategoryRow,
  NotificationStatus,
  NotificationType,
  RuleRow,
  TransactionRow,
  TransactionType,
} from '../db/schema.js';
import { summaryHelpers } from '../routes/summary.js';
import { listNotifications } from '../notifications/store.js';
import { importBillZip } from '../bill/importer.js';
import {
  BillPasswordError,
  BillFormatError,
  BillCsvNotFoundError,
} from '../bill/unzip.js';
import { loadMailConfig, runMailPoll } from '../mail/poller.js';
import { setBillPassword } from '../bill/password-store.js';

const DEFAULT_TX_LIMIT = 100;
const MAX_TX_LIMIT = 500;

const VALID_TX_TYPES: TransactionType[] = ['expense', 'income', 'transfer', 'excluded'];

/** tool 结果的 JSON 序列化：保持精度（不强制 stringify） */
function textResult(payload: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** 注册错误对象（isError:true），host 会把文本展示给用户而不是当成 transport 故障 */
function badResult(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// ── accounts: selectAccounts + withLatestYield（routes/accounts.ts:70/88 同口径） ──

interface AccountListRow {
  id?: number;
  name: string;
  type: string;
  balance: number;
  remark?: string | null;
  tagIds?: string | null;
  includeInNetAsset: number;
  spaceId?: number | null;
  createdAt: number;
  updatedAt: number;
  latestYield: { year: number; annualIncome: number } | null;
}

function selectAccounts(db: Database.Database, where: string, params: unknown[]): AccountListRow[] {
  const rows = db
    .prepare(
      `SELECT a.*,
              y.year AS latestYieldYear,
              y.annualIncome AS latestYieldIncome
         FROM accounts a
         LEFT JOIN accountYields y
                ON y.id = (SELECT id FROM accountYields
                            WHERE accountId = a.id
                            ORDER BY year DESC LIMIT 1)
        ${where}
        ORDER BY a.id ASC`,
    )
    .all(...params) as Array<
    AccountRow & { latestYieldYear: number | null; latestYieldIncome: number | null }
  >;
  return rows.map((row) => {
    const { latestYieldYear, latestYieldIncome, ...account } = row;
    const latestYield =
      typeof latestYieldYear === 'number' && typeof latestYieldIncome === 'number'
        ? { year: latestYieldYear, annualIncome: latestYieldIncome }
        : null;
    return { ...account, latestYield };
  });
}

/**
 * 工厂：返回一个配置好 11 个 tool 的 McpServer 实例。
 * 之所以独立函数而不是顶层单例：测试用 :memory: db，每次起一个 server；
 * stdio 子命令也独立起一个，handler 内部共用 getDb() 单例，与 CLI 现状一致。
 */
export function createMcpServer(db: Database.Database): McpServer {
  const server = new McpServer({ name: 'hifin', version: '0.1.0' });

  // ── hifin_health ─────────────────────────────────────────────
  server.registerTool(
    'hifin_health',
    {
      description: '健康检查；返回 db 是否可读 + 当前时间戳。',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const version = db.pragma('user_version', { simple: true }) as number;
      return textResult({ ok: true, version, ts: Date.now() });
    },
  );

  // ── hifin_accounts_list ──────────────────────────────────────
  server.registerTool(
    'hifin_accounts_list',
    {
      description:
        '账户列表（含每个账户的最新年度收益）；可选按 spaceId 过滤。List accounts with latest annual income; optionally filter by spaceId.',
      inputSchema: z.object({
        spaceId: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const rows = args.spaceId !== undefined
        ? selectAccounts(db, 'WHERE a.spaceId = ?', [args.spaceId])
        : selectAccounts(db, '', []);
      return textResult({ rows });
    },
  );

  // ── hifin_accounts_yields ────────────────────────────────────
  server.registerTool(
    'hifin_accounts_yields',
    {
      description:
        '某账户的年度收益历史（按年倒序）。Annual income history for one account (newest year first).',
      inputSchema: z.object({
        accountId: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const acc = db.prepare('SELECT id FROM accounts WHERE id = ?').get(args.accountId);
      if (!acc) return badResult(`账户不存在: ${args.accountId}`);
      const rows = db
        .prepare(
          `SELECT year, annualIncome, note
             FROM accountYields
            WHERE accountId = ?
            ORDER BY year DESC`,
        )
        .all(args.accountId);
      return textResult({ rows });
    },
  );

  // ── hifin_transactions_query ──────────────────────────────────
  server.registerTool(
    'hifin_transactions_query',
    {
      description:
        '条件查询交易流水；支持 from/to 时间戳、type、accountId、spaceId、limit。默认 100 条、上限 500 条。Query transactions by date/type/account/space; default 100, max 500 rows.',
      inputSchema: z.object({
        from: z.number().int().optional(),
        to: z.number().int().optional(),
        type: z.enum(['expense', 'income', 'transfer', 'excluded']).optional(),
        accountId: z.number().int().positive().optional(),
        spaceId: z.number().int().positive().optional(),
        limit: z
          .number()
          .int()
          .positive()
          .max(MAX_TX_LIMIT)
          .optional()
          .describe(`最多返回 ${MAX_TX_LIMIT} 条；不传或 0 都按 ${DEFAULT_TX_LIMIT} 处理`),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (args.from !== undefined) {
        where.push('date >= ?');
        params.push(args.from);
      }
      if (args.to !== undefined) {
        where.push('date <= ?');
        params.push(args.to);
      }
      if (args.type !== undefined) {
        if (!VALID_TX_TYPES.includes(args.type)) {
          return badResult(`type 必须是 ${VALID_TX_TYPES.join('/')}`);
        }
        where.push('type = ?');
        params.push(args.type);
      }
      if (args.accountId !== undefined) {
        where.push('(accountId = ? OR toAccountId = ?)');
        params.push(args.accountId, args.accountId);
      }
      if (args.spaceId !== undefined) {
        where.push('spaceId = ?');
        params.push(args.spaceId);
      }
      // schema 已卡死 .max(MAX_TX_LIMIT)；缺失时落回 DEFAULT_TX_LIMIT
      const limit = args.limit && args.limit > 0 ? args.limit : DEFAULT_TX_LIMIT;
      const sql = `SELECT * FROM transactions ${
        where.length ? 'WHERE ' + where.join(' AND ') : ''
      } ORDER BY date DESC, id DESC LIMIT ?`;
      const rows = db.prepare(sql).all(...params, limit) as TransactionRow[];
      return textResult({ rows, limit });
    },
  );

  // ── hifin_summary_month ──────────────────────────────────────
  server.registerTool(
    'hifin_summary_month',
    {
      description:
        '看板月度汇总：净资产 + 当月收入/支出/净额 + 环比。Month dashboard: net asset + income/expense/net + MoM delta.',
      inputSchema: z.object({
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/, '必须是 YYYY-MM')
          .optional()
          .describe('YYYY-MM，默认当月'),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const month =
        args.month ??
        (() => {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        })();
      const r = summaryHelpers.monthRange(month);
      if (!r) return badResult(`month 必须是 YYYY-MM，收到: ${month}`);
      const accounts = db.prepare('SELECT * FROM accounts').all() as AccountRow[];
      const txs = db
        .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
        .all(r.start, r.end) as TransactionRow[];
      const monthIncome = summaryHelpers.sumTx(txs, 'income', r.start, r.end);
      const monthExpense = summaryHelpers.sumTx(txs, 'expense', r.start, r.end);
      const monthNet = monthIncome - monthExpense;

      // 上一月：手工算一次，避免引入一个 previousMonth helper
      const m = /^(\d{4})-(\d{2})$/.exec(month)!;
      let py = Number(m[1]);
      let pmo = Number(m[2]) - 1;
      if (pmo === 0) {
        py -= 1;
        pmo = 12;
      }
      const prevMonth = `${py}-${String(pmo).padStart(2, '0')}`;
      const pr = summaryHelpers.monthRange(prevMonth)!;
      const prevTxs = db
        .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
        .all(pr.start, pr.end) as TransactionRow[];
      const prevIncome = summaryHelpers.sumTx(prevTxs, 'income', pr.start, pr.end);
      const prevExpense = summaryHelpers.sumTx(prevTxs, 'expense', pr.start, pr.end);
      const prevNet = prevIncome - prevExpense;
      const momDelta = monthNet - prevNet;
      const momDeltaPct = prevNet !== 0 ? (momDelta / Math.abs(prevNet)) * 100 : null;

      return textResult({
        month,
        netAsset: summaryHelpers.calcNetAsset(accounts),
        monthIncome,
        monthExpense,
        monthNet,
        mom: { delta: momDelta, deltaPct: momDeltaPct, previousMonth: prevMonth },
      });
    },
  );

  // ── hifin_categories_list ────────────────────────────────────
  server.registerTool(
    'hifin_categories_list',
    {
      description: '列出所有分类（支出/收入两方向）。List all categories.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async () => {
      const rows = db
        .prepare('SELECT * FROM categories ORDER BY id ASC')
        .all() as CategoryRow[];
      return textResult({ rows });
    },
  );

  // ── hifin_rules_list ─────────────────────────────────────────
  server.registerTool(
    'hifin_rules_list',
    {
      description: '列出所有规则（可按 enabled/categoryId 过滤）。List auto-categorize rules.',
      inputSchema: z.object({
        enabled: z.boolean().optional(),
        categoryId: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (args.enabled !== undefined) {
        where.push('enabled = ?');
        params.push(args.enabled ? 1 : 0);
      }
      if (args.categoryId !== undefined) {
        where.push('categoryId = ?');
        params.push(args.categoryId);
      }
      const sql = `SELECT * FROM rules ${
        where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
      } ORDER BY priority DESC, id ASC`;
      const rows = db.prepare(sql).all(...params) as RuleRow[];
      return textResult({ rows });
    },
  );

  // ── hifin_notifications_list ─────────────────────────────────
  server.registerTool(
    'hifin_notifications_list',
    {
      description:
        '通知列表（need_password / yield-reminder / ...），按 createdAt DESC。可按 status/type 过滤。List notifications.',
      inputSchema: z.object({
        status: z
          .enum(['pending', 'resolved', 'dismissed', 'failed', 'expired'])
          .optional()
          .describe('按 status 过滤'),
        type: z
          .enum(['need_password', 'password_error', 'import_success', 'import_failed', 'yield-reminder'])
          .optional()
          .describe('按 type 过滤'),
        limit: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const filter: { status?: NotificationStatus; type?: NotificationType; limit?: number } = {};
      if (args.status !== undefined) filter.status = args.status;
      if (args.type !== undefined) filter.type = args.type;
      if (args.limit !== undefined) filter.limit = args.limit;
      const rows = listNotifications(db, filter);
      return textResult({ rows });
    },
  );

  // ── hifin_import_bill (mutating) ─────────────────────────────
  server.registerTool(
    'hifin_import_bill',
    {
      description:
        '[mutating] 解压账单 ZIP 并导入指定账户；密码必填（每次申请账单都不同）；返回 imported/skipped。Import a bill ZIP to an account.',
      inputSchema: z.object({
        zipPath: z.string().min(1),
        platform: z.enum(['alipay', 'wechat']),
        password: z.string().min(1),
        accountId: z.number().int().positive(),
        spaceId: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      try {
        const res = await importBillZip(
          db,
          args.zipPath,
          args.platform,
          args.password,
          args.accountId,
          args.spaceId,
        );
        return textResult({
          platform: res.platform,
          imported: res.imported,
          skipped: res.skipped,
          files: res.files.map((f) => f.split(/[\\/]/).pop() ?? f),
        });
      } catch (e: unknown) {
        // 三类用户预期错误 → tool-level isError，不让 SDK 当 internal error
        if (e instanceof BillPasswordError) {
          return badResult(`解压密码错误：${e.message}`);
        }
        if (e instanceof BillFormatError) {
          return badResult(`账单文件格式错误：${e.message}`);
        }
        if (e instanceof BillCsvNotFoundError) {
          return badResult(`找不到账单表格：${e.message}`);
        }
        throw e;
      }
    },
  );

  // ── hifin_mail_poll (mutating) ──────────────────────────────
  server.registerTool(
    'hifin_mail_poll',
    {
      description:
        '[mutating] 触发一次 IMAP 轮询；返回 fetched/imported/errors 摘要。如果到达账户密码，先调用 hifin_mail_submit_bill_password 再调一次本工具。Trigger one IMAP poll cycle.',
      inputSchema: z.object({
        days: z.number().int().positive().optional().describe('拉取最近多少天，默认 7'),
        accountId: z.number().int().positive(),
        spaceId: z.number().int().positive().optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (args) => {
      const config = loadMailConfig(db);
      if (!config) {
        return badResult('尚未配置邮箱，请先在 Web 端填写 IMAP 凭证或 CLI 跑 `hifin mail config`');
      }
      const summary = await runMailPoll(db, {
        config,
        accountId: args.accountId,
        days: args.days,
        spaceId: args.spaceId,
        billPasswords: undefined, // 走默认共享 Map（poller.ts:582）
      });
      return textResult(summary);
    },
  );

  // ── hifin_mail_submit_bill_password (mutating) ───────────────
  server.registerTool(
    'hifin_mail_submit_bill_password',
    {
      description:
        '[mutating] 提交某条账单通知的解压密码（一次性）；存入进程内 Map，下一次 hifin_mail_poll 触发 import 会自动取走。Submit a bill password for a mail uid.',
      inputSchema: z.object({
        uid: z.number().int(),
        password: z.string().min(1),
      }),
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async (args) => {
      setBillPassword(args.uid, args.password);
      return textResult({ stored: true, uid: args.uid });
    },
  );

  return server;
}