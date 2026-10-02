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
 */

import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { ParsedTx } from './parsers/base.js';
import { detectParser } from './parsers/index.js';

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

export class MailPoller {
  private cfg: MailPollerConfig;
  private client: ImapFlow | null = null;

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

  /** 拉取最近 N 天（默认 7）未读邮件并解析；解析成功的邮件标记为已读 */
  async poll(sinceDays: number = 7): Promise<ParsedTx[]> {
    if (!this.client) {
      throw new MailNetworkError('MailPoller is not connected; call connect() first');
    }
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
        const parser = detectParser(from, subject, );
        if (!parser) continue;
        const source = msg.source;
        const body = source ? source.toString('utf8') : '';
        const txs = safeParse(parser, from, subject, body);
        if (txs.length > 0) {
          out.push(...txs);
          await this.client.messageFlagsAdd(String(uid), ['\\Seen'], {
            uid: true,
          });
        }
      }
    } finally {
      lock.release();
    }
    return out;
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

function safeParse(
  parser: ReturnType<typeof detectParser>,
  from: string,
  subject: string,
  body: string,
): ParsedTx[] {
  try {
    if (!parser) return [];
    // detectParser 返回的是对象；match() 用于二次校验（避免误判）
    if (!parser.match(from, subject)) return [];
    return parser.parse(body);
  } catch {
    return [];
  }
}