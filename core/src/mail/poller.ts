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
 * 账单邮件分两类，本文件对两者都做了处理：
 *   1. 正文内嵌流水的老式邮件 → 走 parser 抽正文（历史行为）
 *   2. 通知型邮件（正文只有"账单已生成"）→ 真正的数据在加密 ZIP 附件里，
 *      用 bodyStructure 找 application/zip / application/octet-stream 部件，
 *      client.download() 存临时文件后交给 bill/importer.ts 自动入库。
 *      附件也没找到的（只有下载链接）→ 标记已读并提示用户手动下载。
 *      注：QQ 邮箱的 IMAP 对 fetchOne 经常返回空 list，故改用 fetch 迭代器取 envelope。
 *
 * 本文件除 MailPoller 外，还提供两段"编排"能力，供 CLI 复用（避免 cli.ts 变成一坨）：
 *   1. 凭证存储：saveMailConfig / loadMailConfig / readMaskedMailConfig
 *      密码单独存 kv['mail.password']，kv['mail.config'] 只存非敏感字段
 *   2. 轮询编排：runMailPoll() —— connect → poll → importTransactions → disconnect
 *      pollerFactory 可注入，测试里塞假 poller 即可，不碰真实 IMAP
 */

import type Database from 'better-sqlite3';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import type { MessageStructureObject } from 'imapflow';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ParsedTx } from './parsers/base.js';
import { detectParser } from './parsers/index.js';
import { importTransactions } from './importer.js';
import { importBillZip } from '../bill/importer.js';
import { unzipBill, findBillCsv, cleanupBillDir, BillCsvNotFoundError } from '../bill/unzip.js';

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

// ── 账单附件识别 ────────────────────────────────────────────

/** 提示文案：无附件的账单邮件只能人工处理 */
export const NO_ATTACHMENT_HINT =
  '发现账单邮件但无附件，请手动下载后用 import-bill 导入';

/** 从发件人/主题猜平台；猜不出返回 null（不乱套默认密码） */
export function detectBillPlatform(from: string, subject: string): string | null {
  const hay = `${from} ${subject}`.toLowerCase();
  if (/alipay|支付宝/.test(hay)) return 'alipay';
  if (/wechat|weixin|微信|财付通/.test(hay)) return 'wechat';
  return null;
}

/** 一个候选附件：part 编号可直接喂给 client.download() */
export interface BillAttachment {
  /** BODYSTRUCTURE part 编号，如 "2" / "1.2" */
  part: string;
  /** 附件文件名（拿不到时为空串） */
  filename: string;
  /** content-type */
  type: string;
}

/** 判定优先级：zip 类型/zip 文件名 > 泛化的 octet-stream */
function attachmentScore(type: string, filename: string): number {
  if (/zip/i.test(type)) return 0;
  if (filename.toLowerCase().endsWith('.zip')) return 0;
  if (/octet-stream/i.test(type)) return 1;
  return -1;
}

/**
 * 在 BODYSTRUCTURE 里找出账单 ZIP 附件。
 *
 * 支持两种形态：
 *   - 已解析的对象（imapflow 正常返回）：递归 childNodes
 *   - 未解析的原始字符串（服务端结构怪，imapflow 解析失败）：视为无附件
 *
 * 命中规则（任一）：content-type 是 application/zip（或任意 *zip*）、
 * 文件名以 .zip 结尾、content-type 是 application/octet-stream。
 * multipart/* 容器节点本身不算附件。
 */
export function findBillAttachments(bodyStructure: unknown): BillAttachment[] {
  const found: BillAttachment[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as MessageStructureObject;
    const type = typeof n.type === 'string' ? n.type : '';
    const filename =
      n.dispositionParameters?.filename ?? n.parameters?.name ?? '';
    // part 形如 "1.2"；multipart 容器虽然也有 part，但它有 childNodes
    const isLeaf = !Array.isArray(n.childNodes) || n.childNodes.length === 0;
    if (isLeaf && typeof n.part === 'string' && n.part.length > 0) {
      const score = attachmentScore(type, filename);
      if (score >= 0) {
        found.push({ part: n.part, filename, type });
      }
    }
    if (Array.isArray(n.childNodes)) {
      for (const child of n.childNodes) walk(child);
    }
  };
  walk(bodyStructure);
  // 稳定的确定性排序：zip 优先，其次原顺序
  return found
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const d = attachmentScore(x.a.type, x.a.filename) - attachmentScore(y.a.type, y.a.filename);
      return d !== 0 ? d : x.i - y.i;
    })
    .map((x) => x.a);
}

/** 一封"通知型"账单邮件的处理结果 */
export interface MailBillOutcome {
  from: string;
  subject: string;
  /** imported=附件已入库；no-attachment=只有下载链接；no-password=检测到账单附件但未提供解压密码；error=附件下载或导入失败 */
  status: 'imported' | 'no-attachment' | 'no-password' | 'error';
  platform?: string;
  /** imported 时为实际写入行数 */
  imported?: number;
  /** no-attachment 时给用户看的话 */
  hint?: string;
  /** error 时的原因 */
  message?: string;
}

/** MailPoller 的账单处理开关；不传 db 就完全不做附件导入 */
export interface MailPollerOptions {
  /** 目标库；给了才会把附件账单自动入库 */
  db?: Database.Database;
  accountId?: number;
  spaceId?: number;
  /** 覆盖平台默认解压密码 */
  billPasswords?: Record<string, string>;
  /** 每封账单邮件处理完回调一次（CLI 用它打印提示） */
  onBill?: (outcome: MailBillOutcome) => void;
}

/** 下载附件到临时目录，返回 { file, dir }；失败抛错（调用方负责清 dir） */
async function downloadAttachment(
  client: ImapFlow,
  uid: number,
  attachment: BillAttachment,
): Promise<{ file: string; dir: string }> {
  const dl = await client.download(String(uid), attachment.part, { uid: true });
  if (!dl || !dl.content) {
    throw new Error(`附件 part ${attachment.part} 下载失败（未找到内容）`);
  }
  const dir = mkdtempSync(join(tmpdir(), 'hifin-mail-'));
  // 附件名可能带路径分隔符或中文乱码，只取基名并强制 .zip 后缀
  const raw = basename(attachment.filename || '').replace(/[/\\]/g, '') || `bill-${uid}`;
  const file = join(dir, raw.toLowerCase().endsWith('.zip') ? raw : `${raw}.zip`);
  await pipeline(dl.content, createWriteStream(file));
  return { file, dir };
}

export class MailPoller {
  private cfg: MailPollerConfig;
  private client: ImapFlow | null = null;
  private stats: MailPollStats = emptyStats();
  private opts: MailPollerOptions;
  /** 账单邮件（附件导入 / 无附件提示）的逐封结果，供 getBillOutcomes() 读取 */
  private bills: MailBillOutcome[] = [];

  constructor(config: MailPollerConfig, options?: MailPollerOptions) {
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
    this.opts = options ?? {};
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
   * 取单封邮件的 envelope / 正文 / bodyStructure。
   *
   * 为什么不用 fetchOne：QQ 邮箱的 IMAP 对 fetchOne 经常返回空的 response.list，
   * 结果是 envelope 拿不到、整封邮件被静默跳过。fetch 迭代器走同一条 FETCH 命令，
   * 但结果以流的形式逐封吐出，行为更可控；老客户端没有 fetch 时才回退 fetchOne。
   */
  private async fetchMessage(uid: number): Promise<Record<string, unknown> | null> {
    const client = this.client;
    if (!client) return null;
    const query = { envelope: true, source: true, bodyStructure: true };
    const options = { uid: true };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c = client as any;
    if (typeof c.fetch === 'function') {
      for await (const msg of c.fetch(String(uid), query, options)) {
        if (msg) return msg as Record<string, unknown>;
        break; // 空结果同样是"没取到"，别空转整个迭代器
      }
      return null;
    }
    const msg = await c.fetchOne(String(uid), query, options);
    return msg ? (msg as Record<string, unknown>) : null;
  }

  /**
   * 处理"通知型"账单邮件：找 ZIP 附件 → 下载 → 自动导入。
   *
   * 返回值：
   *   'imported'      附件已入库 → 应标记 \Seen
   *   'no-attachment' 账单邮件但没有附件（只有下载链接）→ 标记 \Seen 并提示
   *   'error'         下载或导入失败 → 不标记 \Seen，下轮轮询还能重试
   *   null            这压根不是账单邮件 → 当普通未匹配邮件跳过
   *
   * 单封失败不中断整轮，错误记进 bills + stats.errors。
   */
  private async handleBillMail(
    uid: number,
    from: string,
    subject: string,
    bodyStructure: unknown,
  ): Promise<'imported' | 'no-attachment' | 'no-password' | 'error' | null> {
    const platform = detectBillPlatform(from, subject);
    if (!platform) return null;

    const attachments = findBillAttachments(bodyStructure);
    const { db, accountId, spaceId } = this.opts;
    const canImport = !!db && Number.isFinite(accountId) && (accountId as number) > 0;

    // 没有任何账单附件：多半是"去 XX 页面下载"的通知信
    if (attachments.length === 0 || !canImport) {
      const outcome: MailBillOutcome = {
        from,
        subject,
        status: 'no-attachment',
        platform,
        hint: NO_ATTACHMENT_HINT,
      };
      this.bills.push(outcome);
      this.emitBill(outcome);
      // 标记已读：提示一次即可，反复保持未读只会让每轮轮询都重复提示
      return 'no-attachment';
    }

    const password = this.opts.billPasswords?.[platform] ?? '';
    if (!password) {
      const outcome: MailBillOutcome = {
        from,
        subject,
        status: 'no-password',
        platform,
        imported: 0,
      };
      this.bills.push(outcome);
      this.emitBill(outcome);
      return 'no-password';
    }
    const attachment = attachments[0];
    let dir: string | null = null;
    try {
      const { file, dir: tmpDir } = await downloadAttachment(this.client as ImapFlow, uid, attachment);
      dir = tmpDir;
      const result = await importBillZip(
        db as Database.Database,
        file,
        platform,
        password,
        accountId as number,
        spaceId,
      );
      const outcome: MailBillOutcome = {
        from,
        subject,
        status: 'imported',
        platform,
        imported: result.imported,
      };
      this.bills.push(outcome);
      this.emitBill(outcome);
      return 'imported';
    } catch (e: unknown) {
      // 导入失败就不标记已读：下轮轮询还能重试，账单不会被"悄悄吞掉"
      const outcome: MailBillOutcome = {
        from,
        subject,
        status: 'error',
        platform,
        message: errMsg(e),
      };
      this.bills.push(outcome);
      this.emitBill(outcome);
      return 'error';
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  private emitBill(outcome: MailBillOutcome): void {
    try {
      this.opts.onBill?.(outcome);
    } catch {
      /* 回调抛错不该影响轮询 */
    }
  }

  /**
   * 拉取最近 N 天（默认 7）未读邮件并解析；解析成功的邮件标记为已读。
   *
   * 没有匹配 parser 的邮件：跳过并计入 getStats().skipped，不报错、不标记 \Seen
   * （保持未读，下次轮询仍可复查，避免"悄悄吞掉"账单）。
   * 通知型账单邮件：正文抽不出交易时再走附件分支，详见 handleBillMail()。
   */
  async poll(sinceDays: number = 7): Promise<ParsedTx[]> {
    if (!this.client) {
      throw new MailNetworkError('MailPoller is not connected; call connect() first');
    }
    const stats = emptyStats();
    this.stats = stats;
    this.bills = [];
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
        const msg = await this.fetchMessage(uid);
        if (!msg) continue;
        const envelope = msg.envelope as
          | { from?: Array<{ name?: string; address?: string }>; subject?: string }
          | undefined;
        const from = envelope?.from?.[0]
          ? `${envelope.from[0].name ?? ''} <${envelope.from[0].address ?? ''}>`
          : '';
        const subject = envelope?.subject ?? '';
        stats.fetched++;

        const markSeen = async (): Promise<void> => {
          await this.client?.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        };

        // ① 正文内嵌流水：老式账单邮件走这条路（历史行为，优先级最高）
        const parser = detectParser(from, subject);
        let parsedOk = false;
        if (parser) {
          const source = msg.source as Buffer | undefined;
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
          if (txs.length > 0) {
            stats.parsed++;
            stats.transactions += txs.length;
            out.push(...txs);
            parsedOk = true;
            await markSeen();
          }
        }

        // ② 正文没交易 → 通知型账单邮件：找 ZIP 附件自动导入
        if (!parsedOk) {
          const bill = await this.handleBillMail(uid, from, subject, msg.bodyStructure);
          if (bill === 'imported' || bill === 'no-attachment') {
            await markSeen();
          }
          // 只有附件真的入库了才算"处理成功"；其余一律计入 skipped，
          // 保证 skipped 始终等于"本轮没能拿到交易"的邮件数。
          if (bill !== 'imported') {
            stats.skipped++;
            if (bill === 'error') {
              stats.errors.push({ from, subject, message: '账单附件导入失败' });
            }
          }
        }
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

  /**
   * 最近一次 poll() 里各封账单邮件的处理结果。
   * 单独开一个方法而不是塞进 getStats()，是为了不改动既有 stats 的字段形状。
   */
  getBillOutcomes(): MailBillOutcome[] {
    return this.bills.map((b) => ({ ...b }));
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

/**
 * runMailPoll 只需要 poller 的这三个动作 + 统计；方便测试注入假实现。
 * 第二个参数 MailPollerOptions 只给真实 MailPoller 用（账单附件导入）；
 * 注入的假 poller 忽略它即可。
 */
export interface PollerLike {
  connect(): Promise<void>;
  poll(days: number): Promise<ParsedTx[]>;
  disconnect(): Promise<void>;
  getStats?(): MailPollStats;
}

export type PollerFactory = (config: MailPollerConfig, options?: MailPollerOptions) => PollerLike;

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
  /**
   * 每封账单邮件处理完回调一次（CLI 用它把"无附件、请手动导入"的提示打出来）。
   * 刻意不改 MailPollSummary 的字段形状：既有调用方按 {fetched,parsed,...} 取值。
   */
  onBill?: (outcome: MailBillOutcome) => void;
  /** 覆盖平台默认解压密码 */
  billPasswords?: Record<string, string>;
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
  const factory: PollerFactory = opts.pollerFactory ?? ((cfg, o) => new MailPoller(cfg, o));
  const pollerOptions: MailPollerOptions = {
    db,
    accountId: opts.accountId,
    spaceId: opts.spaceId ?? 1,
    onBill: opts.onBill,
    billPasswords: opts.billPasswords,
  };
  const poller = factory(opts.config, pollerOptions);
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
