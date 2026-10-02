/**
 * IMAP 邮件轮询器（基于 imapflow）
 * 用法：
 *     const poller = new MailPoller({ host, port, user, password, tls: true });
 *     await poller.connect();
 *     const txs = await poller.poll(7);    // 最近 7 天
 *     await poller.disconnect();
 *
 * 行为：
 *   - 打开 INBOX，搜索 UNSEEN 且 SINCE（最近 N 天或全 N 天）
 *   - 对每封邮件 fetch body 并按 from/subject 匹配 parser 抽取交易
 *   - 抽取成功的邮件 标记 \Seen
 *   - 密码绝不打印/返回；错误按 auth/network 分类型抛出
 *
 * 本文件除 MailPoller 外，还提供两段"编排"能力，供 CLI 复用（避免 cli.ts 变成一坨）：
 *   1. 凭证存储：saveMailConfig / loadMailConfig / readMaskedMailConfig
 *      密码单独存 kv['mail.password']，kv['mail.config'] 只存非敏感字段
 *   2. 轮询编排：runMailPoll() —— connect → poll → importTransactions → disconnect
 *      pollerFactory 可注入，测试里塞假 poller 即可，不碰真实 IMAP
 */

import type Database from 'better-sqlite3';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { ParsedTx } from './parsers/base.js';
import { detectParser } from './parsers/index.js';
import { importTransactions } from './importer.js';

export interface MailPollerConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
  mailbox?: string;
}

export class MailAuthError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MailAuthError';
  }
}

export class MailNetworkError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'MailNetworkError';
  }
}

// ── kv 表 key ─────────────────────────────────────────────
/** IMAP 配置（非敏感部分，JSON 序列化） */
export const MAIL_CONFIG_KEY = 'mail.config';
/** 密码单独存放；config 视图/导出永远不读它 */
export const MAIL_PASSWORD_KEY = 'mail.password';
/** 掩码视图里替代真实密码的占位符 */
export const MASKED_PASSWORD = '******';

// ── 统计 ─────────────────────────────────────────────────
export interface MailPollIssue {
  from: string;
  subject: string;
  message: string;
}

export interface MailPollStats {
  /** 实际 fetch 到的邮件数 */
  fetched: number;
  /** 成功解析出交易的邮件数 */
  parsed: number;
  /** 解析出的交易条目总数（ParsedTx.length） */
  transactions: number;
  /** 跳过的邮件数：没有匹配 parser，或 parser 命中但正文里没有交易。
   *  这属于正常情况（收件箱里本来就有非账单邮件），只记录、不报错。 */
  skipped: number;
  /** 解析过程抛错的邮件；单封失败不中断整轮轮询 */
  errors: MailPollIssue[];
}

function emptyStats(): MailPollStats {
  return { fetched: 0, parsed: 0, transactions: 0, skipped: 0, errors: [] };
}

export class MailPoller {
  private cfg: MailPollerConfig;
  private client: ImapFlow | null = null;
  private stats: MailPollStats = emptyStats();

  constructor(config: MailPollerConfig) {
    if (!config || !config.host || !config.user || !config.password) {
      throw new Error('MailPoller config requires host/user/password');
    }
    if (!Number.isFinite(config.port) || config.port <= 0) {
      throw new Error('MailPoller config.port must be a positive number');
    }
    // password 设为不可枚举，避免 JSON.stringify / 简单对象遍历时泄露
    const safe = {
      host: config.host,
      port: config.port,
      user: config.user,
      mailbox: config.mailbox ?? 'INBOX',
      tls: config.tls ?? true,
    };
    Object.defineProperty(safe, 'password', {
      value: config.password,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    this.cfg = safe as MailPollerConfig;
  }

  /** 连接到 IMAP 服务器；区分认证错误与网络错误 */
  async connect(): Promise<void> {
    const opts: ImapFlowOptions = {
      host: this.cfg.host,
      port: this.cfg.port,
      secure: this.cfg.tls ?? true,
      auth: { user: this.cfg.user, pass: this.cfg.password },
      logger: false,
    };
    try {
      this.client = new ImapFlow(opts);
      await this.client.connect();
    } catch (e: unknown) {
      this.client = null;
      const msg = errMsg(e);
      if (/auth|credential|password|login/i.test(msg)) {
        throw new MailAuthError(`IMAP authentication failed: ${msg}`);
      }
      if (/timeout|econnrefused|enotfound|econnreset|etimedout|network/i.test(msg)) {
        throw new MailNetworkError(`IMAP network error: ${msg}`);
      }
      throw e;
    }
  }

  /**
   * 拉取最近 N 天（默认 7）未读邮件并解析；解析成功的邮件标记为已读。
   *
   * 没有匹配 parser 的邮件：跳过并计入 getStats().skipped，不报错、不标记 \Seen
   * （保持未读，下次轮询仍可复查，避免"悄悄吞掉"账单）。
   */
  async poll(sinceDays: number = 7): Promise<ParsedTx[]> {
    if (!this.client) {
      throw new MailNetworkError('MailPoller is not connected; call connect() first');
    }
    const stats = emptyStats();
    this.stats = stats;
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
    const lock = await this.client.getMailboxLock(this.cfg.mailbox || 'INBOX');
    const out: ParsedTx[] = [];
    try {
      const uids = await this.client.search({
        seen: false,
        since,
      });
      if (!uids || (Array.isArray(uids) && uids.length === 0)) {
        return out;
      }
      const uidList: number[] = Array.isArray(uids) ? uids : [];
      for (const uid of uidList) {
        const msg = await this.client.fetchOne(String(uid), {
          envelope: true,
          source: true,
        }, { uid: true });
        if (!msg) continue;
        const from = msg.envelope?.from?.[0]
          ? `${msg.envelope.from[0].name ?? ''} <${msg.envelope.from[0].address ?? ''}>`
          : '';
        const subject = msg.envelope?.subject ?? '';
        stats.fetched++;

        const parser = detectParser(from, subject);
        if (!parser) {
          // 非账单邮件：跳过并记录，不报错
          stats.skipped++;
          continue;
        }
        const source = msg.source;
        const body = source ? source.toString('utf8') : '';
        let txs: ParsedTx[];
        try {
          // detectParser 已用 match() 选型，这里再校一次，避免误判
          txs = parser.match(from, subject) ? parser.parse(body) : [];
        } catch (e: unknown) {
          // 单封解析失败不中断整轮：记录后继续
          stats.errors.push({ from, subject, message: errMsg(e) });
          continue;
        }
        if (txs.length === 0) {
          stats.skipped++;
          continue;
        }
        stats.parsed++;
        stats.transactions += txs.length;
        out.push(...txs);
        await this.client.messageFlagsAdd(String(uid), ['\\Seen'], {
          uid: true,
        });
      }
    } finally {
      lock.release();
    }
    return out;
  }

  /** 最近一次 poll() 的统计（fetched / parsed / transactions / skipped / errors） */
  getStats(): MailPollStats {
    return { ...this.stats, errors: this.stats.errors.map((e) => ({ ...e })) };
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      try {
        await this.client.logout();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
  }
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === 'string') return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

// ── 凭证存储（kv 表） ─────────────────────────────────────

export interface MailConfigInput {
  host: string;
  port: number;
  user: string;
  password: string;
  tls?: boolean;
  mailbox?: string;
}

export type MailConfigPatch = Partial<MailConfigInput>;

/** 掩码后的配置视图：可安全打印 / 导出，永不含明文密码 */
export interface MailConfigView {
  host: string;
  port: number;
  user: string;
  tls: boolean;
  mailbox: string;
  /** 恒为 MASKED_PASSWORD；尚未存密码时为 null */
  password: string | null;
  updatedAt: number | null;
}

function kvGet(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row && typeof row.value === 'string' ? row.value : null;
}

function kvSet(db: Database.Database, key: string, value: string): void {
  db
    .prepare(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    )
    .run(key, value);
}

/** 单独读取密码（只有 poll 用；不要直接打印） */
export function readMailPassword(db: Database.Database): string | null {
  return kvGet(db, MAIL_PASSWORD_KEY);
}

/** 读取掩码视图（`mail config --show` 用）；未配置返回 null */
export function readMaskedMailConfig(db: Database.Database): MailConfigView | null {
  const raw = kvGet(db, MAIL_CONFIG_KEY);
  if (!raw) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  return {
    host: String(obj.host ?? ''),
    port: Number(obj.port ?? 993),
    user: String(obj.user ?? ''),
    tls: obj.tls === undefined ? true : Boolean(obj.tls),
    mailbox: String(obj.mailbox ?? 'INBOX'),
    password: readMailPassword(db) ? MASKED_PASSWORD : null,
    updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : null,
  };
}

/** 读取完整配置（含明文密码，`mail poll` 用）；未配置返回 null */
export function loadMailConfig(db: Database.Database): MailConfigInput | null {
  const view = readMaskedMailConfig(db);
  if (!view) return null;
  const password = readMailPassword(db);
  if (!password) return null;
  return {
    host: view.host,
    port: view.port,
    user: view.user,
    password,
    tls: view.tls,
    mailbox: view.mailbox,
  };
}

/**
 * 写入 / 更新 IMAP 凭证。
 * - 增量语义：只覆盖显式传入的字段；不传 password 时保留已存密码
 * - 密码写 kv['mail.password']；kv['mail.config'] 只留非敏感字段
 * - 返回掩码视图
 */
export function saveMailConfig(
  db: Database.Database,
  patch: MailConfigPatch,
): MailConfigView {
  const prev = readMaskedMailConfig(db);
  const host = patch.host ?? prev?.host;
  const user = patch.user ?? prev?.user;
  const port = patch.port ?? prev?.port ?? 993;
  const tls = patch.tls ?? prev?.tls ?? true;
  const mailbox = patch.mailbox ?? prev?.mailbox ?? 'INBOX';
  if (!host) throw new Error('缺少 --host（首次配置必填）');
  if (!user) throw new Error('缺少 --user（首次配置必填）');
  if (!Number.isFinite(port) || port <= 0) throw new Error('--port 必须是正整数');

  const password = patch.password ? patch.password : readMailPassword(db);
  if (!password) throw new Error('缺少 --password（首次配置必填）');

  const updatedAt = Date.now();
  const publicJson = JSON.stringify({ host, port, user, tls, mailbox, updatedAt });
  db.transaction(() => {
    kvSet(db, MAIL_CONFIG_KEY, publicJson);
    kvSet(db, MAIL_PASSWORD_KEY, password);
  })();
  return {
    host,
    port,
    user,
    tls,
    mailbox,
    password: MASKED_PASSWORD,
    updatedAt,
  };
}

// ── 轮询编排（CLI `mail poll` 的实现体） ───────────────────

/** runMailPoll 只需要 poller 的这三个动作 + 统计；方便测试注入假实现 */
export interface PollerLike {
  connect(): Promise<void>;
  poll(days: number): Promise<ParsedTx[]>;
  disconnect(): Promise<void>;
  getStats?(): MailPollStats;
}

export type PollerFactory = (config: MailPollerConfig) => PollerLike;

export interface MailPollSummary {
  /** 本轮 fetch 到的邮件数 */
  fetched: number;
  /** 解析出的交易条目数 */
  parsed: number;
  /** 实际写入 transactions 的交易数 */
  imported: number;
  /** 跳过数 = 无匹配 parser/正文为空的邮件数 + importer 去重跳过数 */
  skipped: number;
  errors: MailPollIssue[];
}

export interface RunMailPollOptions {
  config: MailPollerConfig;
  accountId: number;
  days?: number;
  spaceId?: number;
  /** 注入点：测试传假 poller，生产走默认 new MailPoller(config) */
  pollerFactory?: PollerFactory;
}

/**
 * connect → poll → importTransactions → disconnect
 * 无论导入成功与否都保证 disconnect()（放 finally）。
 * accountId 不存在等致命错误会向上抛，由 CLI 转成非零退出码。
 */
export async function runMailPoll(
  db: Database.Database,
  opts: RunMailPollOptions,
): Promise<MailPollSummary> {
  const days = opts.days ?? 7;
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('days 必须是正数');
  }
  if (!Number.isFinite(opts.accountId) || opts.accountId <= 0) {
    throw new Error('accountId 必须是正整数');
  }
  const factory: PollerFactory = opts.pollerFactory ?? ((cfg) => new MailPoller(cfg));
  const poller = factory(opts.config);
  const summary: MailPollSummary = {
    fetched: 0,
    parsed: 0,
    imported: 0,
    skipped: 0,
    errors: [],
  };

  await poller.connect();
  try {
    const txs = await poller.poll(days);
    summary.parsed = txs.length;
    const stats = poller.getStats?.();
    if (stats) {
      summary.fetched = stats.fetched;
      summary.skipped = stats.skipped;
      summary.errors = stats.errors.map((e) => ({ ...e }));
    }
    const res = importTransactions(db, txs, opts.accountId, { spaceId: opts.spaceId ?? 1 });
    summary.imported = res.imported;
    summary.skipped += res.skipped;
  } finally {
    await poller.disconnect();
  }
  return summary;
}
