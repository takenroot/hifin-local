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
 *      微信这类"无附件、只有下载链接"的邮件 → 先从正文抽 URL，HTTP 下载 ZIP，
 *      之后同样走解压密码流程。
 *
 * 解压密码是"一次性"的（每次申请账单都不同），所以账单处理被建模成一个
 * 最多重试 3 次的状态机，状态存在 notifications 表里：
 *
 *      无密码 ──► need_password（不标记已读，下轮轮询还会来看一眼）
 *        │用户提交密码（存进内存，见 bill/password-store.ts）
 *        ▼
 *      有密码 ──解压成功──► import_success + 标记已读 + 清掉内存密码
 *        │
 *        └─解压失败──► password_error（retry_count+1，附"还剩 N 次"）
 *                        retry_count >= 3 ──► 通知转 failed + 标记已读，不再自动尝试
 *
 * 通知与 URL 提取器都是"可选依赖"：默认在运行时去 ../notifications/store.js 与
 * ./url-extractor.js 软加载（那两个文件由别的模块提供），加载不到就降级为 no-op /
 * 旧版 no-attachment 提示，轮询本身照常跑完。测试则直接注入假实现，不碰磁盘。
 *
 * 注：QQ 邮箱的 IMAP 对 fetchOne 经常返回空 list，故改用 fetch 迭代器取 envelope。
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
import { createWriteStream, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ParsedTx } from './parsers/base.js';
import { detectParser } from './parsers/index.js';
import { importTransactions } from './importer.js';
import { importBillZip } from '../bill/importer.js';
import { unzipBill, findBillCsv, cleanupBillDir, BillCsvNotFoundError, BillPasswordError } from '../bill/unzip.js';
import { getBillPasswordMap } from '../bill/password-store.js';

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
  /** imported=附件已入库；no-attachment=只有下载链接；no-password=检测到账单附件但未提供解压密码；
   *  error=附件下载或导入失败（含密码错误）；exhausted=密码连错达到上限，本封不再自动尝试 */
  status: 'imported' | 'no-attachment' | 'no-password' | 'error' | 'exhausted';
  platform?: string;
  /** imported 时为实际写入行数 */
  imported?: number;
  /** no-attachment 时给用户看的话 */
  hint?: string;
  /** error 时的原因 */
  message?: string;
  /** error 且属于"密码错误"时为 true（与下载/格式失败区分开） */
  passwordError?: boolean;
  /** error(密码错误) 时"还剩几次机会"；exhausted 时为 0 */
  remainingRetries?: number;
  /** exhausted 时为 true：已标记已读，后续轮询不会再碰这封邮件 */
  exhausted?: boolean;
}

// ── 通知存储（可注入） ────────────────────────────────────────

/** 通知类型；与 notifications 表 CHECK 约束一一对应 */
export type BillNotificationType =
  | 'need_password'
  | 'password_error'
  | 'import_success'
  | 'import_failed';

export type BillNotificationStatus = 'pending' | 'resolved' | 'dismissed' | 'failed';

/** 落库前的通知内容（字段名与 notifications 表列名一致） */
export interface BillNotificationInput {
  type: BillNotificationType;
  title: string;
  message?: string;
  bill_uid?: number;
  platform?: string;
}

/** 读回来的通知（只声明 poller 真正用到的字段） */
export interface BillNotification {
  id?: number;
  type: string;
  title?: string;
  message?: string;
  bill_uid?: number;
  platform?: string;
  status: string;
  retry_count: number;
}

/**
 * 通知列表过滤条件。
 * bill_uid 由本文件在客户端二次过滤——notifications/store.js 的过滤项里只有
 * status/type/limit，而状态机必须按邮件 uid 定位通知，不能只靠库里过滤。
 */
export interface BillNotificationFilter {
  status?: BillNotificationStatus;
  type?: BillNotificationType;
  bill_uid?: number;
}

/**
 * poller 需要的通知能力子集。
 * 默认接 ../notifications/store.js；测试注入内存假实现，不碰 SQLite。
 */
export interface BillNotificationStore {
  createNotification(input: BillNotificationInput): BillNotification | undefined;
  listNotifications(filter?: BillNotificationFilter): BillNotification[];
  incrementRetry(id: number): number | undefined;
  resolveNotification(id: number): void;
  /**
   * 改状态。可选能力：真实 store 若没有对应函数，poller 退化成"只清 retry_count、
   * 不改状态"，状态机本身照常跑完（通知留在 pending，用户仍能手动 resolve）。
   */
  setNotificationStatus?(id: number, status: BillNotificationStatus): void;
}

/** 通知相关调用一律包一层 try/catch：通知挂了不能连累账单导入 */
function safeCall<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * 把 notifications/store.js 适配成 BillNotificationStore。
 *
 * 两处必须转换，否则接不上真 store：
 *   1. 它的每个函数第一个参数都是 db（createNotification(db, input) 这种），
 *      这里把 poller 手上的 db 绑死进去，对外只暴露"收什么、放什么"的干净接口。
 *   2. listNotifications 的过滤项不含 bill_uid，返回的是整个表；按 uid 的筛选
 *      在这里客户端做，避免把全表拉出来还当成"这封邮件的通知"。
 */
export function adaptNotificationStore(
  mod: unknown,
  db: Database.Database,
): BillNotificationStore | null {
  if (!mod || typeof mod !== 'object') return null;
  const m = mod as Record<string, unknown>;
  const create = m.createNotification;
  const list = m.listNotifications;
  if (typeof create !== 'function' || typeof list !== 'function') return null;

  const toRow = (raw: unknown): BillNotification | null => {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0);
    return {
      id: typeof r.id === 'number' ? r.id : undefined,
      type: String(r.type ?? ''),
      title: r.title === null || r.title === undefined ? undefined : String(r.title),
      message: r.message === null || r.message === undefined ? undefined : String(r.message),
      bill_uid: r.bill_uid === null || r.bill_uid === undefined ? undefined : num(r.bill_uid),
      platform: r.platform === null || r.platform === undefined ? undefined : String(r.platform),
      status: String(r.status ?? 'pending'),
      retry_count: num(r.retry_count),
    };
  };

  const store: BillNotificationStore = {
    createNotification(input) {
      const row = safeCall(
        () => (create as (d: Database.Database, i: BillNotificationInput) => unknown)(db, input),
        undefined,
      );
      return toRow(row) ?? undefined;
    },
    listNotifications(filter) {
      // 只把 store 认识的过滤项传下去，bill_uid 留给自己过滤
      const native: Record<string, unknown> = {};
      if (filter?.status !== undefined) native.status = filter.status;
      if (filter?.type !== undefined) native.type = filter.type;
      const rows = safeCall(
        () => (list as (d: Database.Database, f: unknown) => unknown)(db, native),
        [],
      );
      if (!Array.isArray(rows)) return [];
      return rows
        .map(toRow)
        .filter((r): r is BillNotification => r !== null)
        .filter((r) => filter?.bill_uid === undefined || r.bill_uid === filter.bill_uid);
    },
    incrementRetry(id) {
      const fn = m.incrementRetry;
      if (typeof fn !== 'function') return undefined;
      const r = safeCall(() => (fn as (d: Database.Database, i: number) => unknown)(db, id), undefined);
      return typeof r === 'number' && Number.isFinite(r) ? r : undefined;
    },
    resolveNotification(id) {
      safeCall(() => {
        const fn = m.resolveNotification;
        if (typeof fn === 'function') (fn as (d: Database.Database, i: number) => unknown)(db, id);
      }, undefined);
    },
  };

  // 改状态：store 提供了专用函数就用专用的，否则退回 dismissed
  // （dismissed 的唯一作用就是"别再出现在待办列表里"，正好对上"避免反复弹窗"）
  const setStatus = store.setNotificationStatus = (id, status) => {
    const pick =
      status === 'resolved'
        ? m.resolveNotification
        : status === 'dismissed'
          ? m.dismissNotification
          : m.failNotification ?? m.setNotificationStatus;
    if (typeof pick !== 'function') {
      const fallbackFn = m.dismissNotification;
      if (typeof fallbackFn === 'function') {
        safeCall(() => (fallbackFn as (d: Database.Database, i: number) => unknown)(db, id), undefined);
      }
      return;
    }
    safeCall(() => {
      if (status === 'failed' && pick === m.failNotification) {
        (pick as (d: Database.Database, i: number) => unknown)(db, id);
      } else {
        (pick as (d: Database.Database, i: number, s: string) => unknown)(db, id, status);
      }
    }, undefined);
  };

  return store;
}

/**
 * 运行时软加载一个"可能还没落地/尚未打包"的同级模块。
 *
 * 用变量拼 specifier 是刻意的：这样 tsc 不会在编译期去解析这个文件，
 * 通知模块缺席时 tsc 依旧通过，运行时则安静地降级（返回 null）。
 */
async function loadOptionalModule(specifier: string): Promise<unknown | null> {
  try {
    const mod = (await import(specifier)) as unknown;
    return mod ?? null;
  } catch {
    return null;
  }
}

// ── 微信下载链接提取 / ZIP 下载（可注入） ──────────────────────

/** 从账单邮件正文（HTML 原文）里抽出"立即下载"链接；抽不出返回 null */
export type WechatUrlExtractor = (html: string) => string | null;

/** 按 URL 下载账单 ZIP，返回 ZIP 字节；失败抛错 */
export type BillZipDownloader = (url: string) => Promise<Buffer>;

/** 默认 URL 提取器：软加载 ./url-extractor.js，模块缺席时返回 null（退化成旧提示） */
async function defaultUrlExtractor(): Promise<WechatUrlExtractor | null> {
  const mod = await loadOptionalModule('./url-extractor.js');
  if (!mod || typeof mod !== 'object') return null;
  const fn = (mod as Record<string, unknown>).extractWechatDownloadUrl;
  return typeof fn === 'function' ? (fn as WechatUrlExtractor) : null;
}

/** 下载体积上限：账单 ZIP 常见 20–50MB，200MB 足够挡住"点到钓鱼链接" */
const MAX_BILL_ZIP_BYTES = 200 * 1024 * 1024;

/** 单次下载超时；账单链接都是现成的，等太久没意义 */
const BILL_DOWNLOAD_TIMEOUT_MS = 60_000;

/**
 * 默认 ZIP 下载器：走全局 fetch（Node 18+）。
 * 只放行 http/https、写盘前的字节数有上限、响应不是 2xx 一律抛错。
 */
const defaultZipDownloader: BillZipDownloader = async (url) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`账单下载链接非法: ${url}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`账单下载链接协议不支持: ${parsed.protocol}`);
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), BILL_DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, { signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) {
      throw new Error(`账单 ZIP 下载失败: HTTP ${res.status}`);
    }
    const len = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(len) && len > MAX_BILL_ZIP_BYTES) {
      throw new Error(`账单 ZIP 过大: ${len} 字节`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BILL_ZIP_BYTES) {
      throw new Error(`账单 ZIP 过大: ${buf.length} 字节`);
    }
    if (buf.length === 0) {
      throw new Error('账单 ZIP 下载为空');
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
};

/** 把下载到的 ZIP 字节落到临时目录，返回 { file, dir } */
function writeZipToTempDir(uid: number, zip: Buffer): { file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'hifin-mail-'));
  const file = join(dir, `bill-${uid}.zip`);
  writeFileSync(file, zip);
  return { file, dir };
}

// ── 密码重试状态机 ───────────────────────────────────────────

/** 密码连错多少次就放弃自动尝试（设计文档 §七：防暴力破解 + 防用户反复输错烦） */
export const MAX_BILL_PASSWORD_RETRIES = 3;

/** 重试到顶后的兜底提示（通知转 failed，邮件标记已读，不再反复弹窗） */
export const PASSWORD_EXHAUSTED_HINT =
  '解压密码连续输错次数过多，已停止自动导入，请手动下载账单后用 import-bill 导入';

/** 平台中文名，通知标题用 */
function platformLabel(platform: string): string {
  return platform === 'alipay' ? '支付宝' : platform === 'wechat' ? '微信' : platform;
}

/**
 * 判断导入失败是不是"密码错"而不是"文件坏了"。
 * unzipBill 抛的是 BillPasswordError；这里再兜一层文案匹配，
 * 以防中间层（解压库 / 驱动）换了个别的 Error 类型。
 */
function isPasswordError(e: unknown): boolean {
  if (e instanceof BillPasswordError) return true;
  const msg = errMsg(e);
  return /wrong\s*password|invalid\s*password|password|密码/i.test(msg);
}


/** MailPoller 的账单处理开关；不传 db 就完全不做附件导入 */
export interface MailPollerOptions {
  /** 目标库；给了才会把附件账单自动入库 */
  db?: Database.Database;
  accountId?: number;
  spaceId?: number;
  /**
   * 账单解压密码。
   *   - `Map<uid, string>`：新语义，一封邮件一把一次性密码（推荐，见 bill/password-store.ts）
   *   - `Record<platform, string>`：旧语义，CLI `--bill-password-alipay` 用的平台级兜底，保留兼容
   * 省略时用 password-store 的共享 Map（"接口写入 → poller 读出"无需额外接线）。
   */
  billPasswords?: Map<number, string> | Record<string, string>;
  /** 每封账单邮件处理完回调一次（CLI 用它打印提示） */
  onBill?: (outcome: MailBillOutcome) => void;
  /** 导入进度（importBillZip 提交后回调已写入行数） */
  onBillProgress?: (info: { uid: number; platform: string; imported: number }) => void;
  /** 通知存储；省略时软加载 ../notifications/store.js，加载不到则不产生通知 */
  notifications?: BillNotificationStore;
  /** 微信无附件邮件的 URL 提取器；省略时软加载 ./url-extractor.js */
  extractWechatUrl?: WechatUrlExtractor;
  /** 微信 ZIP 的 HTTP 下载器；省略时用内置 fetch 实现 */
  downloadBillZip?: BillZipDownloader;
  /** 密码连错上限，默认 MAX_BILL_PASSWORD_RETRIES(3) */
  maxBillRetries?: number;
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
  /** 生效的密码表：注入的 Map，或 password-store 的共享 Map（进程内唯一） */
  private passwords: Map<number, string> | Record<string, string>;
  /** 密码连错上限 */
  private maxRetries: number;
  /** 生效的 ZIP 下载器（注入优先，否则内置 fetch） */
  private downloader: BillZipDownloader;
  /** 通知存储：undefined=尚未加载，null=加载过但没有（无通知能力） */
  private notifStore: BillNotificationStore | null | undefined = undefined;
  /** 微信 URL 提取器：undefined=尚未加载，null=加载过但没有 */
  private urlExtractor: WechatUrlExtractor | null | undefined = undefined;
  /**
   * uid → 已用掉的重试次数（内存兜底）。
   * 通知表是权威来源，这里只是保证"通知模块缺席 / 换实例"时 3 次封顶依然生效。
   */
  private retryCounters = new Map<number, number>();

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
    // 省略时用共享 Map：Web 端 POST 密码写进去，poller 下一轮就能直接读到
    this.passwords = this.opts.billPasswords ?? getBillPasswordMap();
    this.maxRetries =
      Number.isFinite(this.opts.maxBillRetries) && (this.opts.maxBillRetries as number) > 0
        ? Math.trunc(this.opts.maxBillRetries as number)
        : MAX_BILL_PASSWORD_RETRIES;
    this.downloader = this.opts.downloadBillZip ?? defaultZipDownloader;
    if (this.opts.notifications) this.notifStore = this.opts.notifications;
    if (this.opts.extractWechatUrl) this.urlExtractor = this.opts.extractWechatUrl;
  }

  // ── 可选依赖的懒加载 ───────────────────────────────────────

  /**
   * 通知存储：注入优先，否则软加载 ../notifications/store.js。
   * 真 store 的每个函数都要 db，没 db 就等于没有通知能力（这时候本来也不导入账单）。
   */
  private async notifications(): Promise<BillNotificationStore | null> {
    if (this.notifStore === undefined) {
      const db = this.opts.db;
      if (!db) {
        this.notifStore = null;
      } else {
        this.notifStore = adaptNotificationStore(
          await loadOptionalModule('../notifications/store.js'),
          db,
        );
      }
    }
    return this.notifStore;
  }

  /** 微信 URL 提取器：注入优先，否则软加载 ./url-extractor.js；加载不到就 null */
  private async wechatUrlExtractor(): Promise<WechatUrlExtractor | null> {
    if (this.urlExtractor === undefined) {
      const mod = await loadOptionalModule('./url-extractor.js');
      const fn = mod && typeof mod === 'object'
        ? (mod as Record<string, unknown>).extractWechatDownloadUrl
        : undefined;
      this.urlExtractor = typeof fn === 'function' ? (fn as WechatUrlExtractor) : null;
    }
    return this.urlExtractor;
  }

  // ── 密码 / 通知小工具 ─────────────────────────────────────

  /**
   * 取某封邮件的解压密码。
   * 优先 uid 精确匹配（新语义：一封邮件一把密码），退回到平台级兜底（旧 CLI 语义）。
   */
  private billPasswordFor(uid: number, platform: string): string {
    const pwd = this.passwords;
    if (pwd instanceof Map) {
      return pwd.get(uid) ?? '';
    }
    return pwd[platform] ?? '';
  }

  /** 导入成功后清掉这封邮件的密码（一次性密码用完即焚） */
  private forgetPassword(uid: number): void {
    if (this.passwords instanceof Map) {
      this.passwords.delete(uid);
    }
  }

  /** 某封邮件当前还"待处理"的最新通知（取 id 最大 / updatedAt 最新的那条） */
  private async pendingNotification(
    store: BillNotificationStore,
    uid: number,
  ): Promise<BillNotification | null> {
    const rows = store.listNotifications({ bill_uid: uid, status: 'pending' });
    if (rows.length === 0) return null;
    return rows.reduce((a, b) => ((b.id ?? 0) > (a.id ?? 0) ? b : a));
  }

  /** 收掉某封邮件已有的待处理通知：换了一条提示就不该让旧提示继续弹窗 */
  private async retirePending(store: BillNotificationStore, uid: number): Promise<void> {
    const prev = await this.pendingNotification(store, uid);
    if (prev?.id !== undefined) {
      if (store.setNotificationStatus) {
        store.setNotificationStatus(prev.id, 'dismissed');
      } else {
        store.resolveNotification(prev.id);
      }
    }
  }

  /**
   * 这封邮件已经用掉几次重试机会。
   *
   * 每次密码错误都会新建一条 password_error 通知（用户只看最新那条），
   * 所以单行的 retry_count 表达不了累计次数——取该邮件所有通知里的最大值，
   * 再和内存计数器取大者：既能在通知模块缺席时封顶，也能在进程重启后从库里续上。
   */
  private async usedRetries(uid: number, store: BillNotificationStore | null): Promise<number> {
    const inMem = this.retryCounters.get(uid) ?? 0;
    if (!store) return inMem;
    const rows = store.listNotifications({ bill_uid: uid });
    const fromDb = rows.reduce((m, r) => Math.max(m, r.retry_count ?? 0), 0);
    return Math.max(inMem, fromDb);
  }

  /**
   * 把新建的通知行的 retry_count 补到累计次数。
   * 这一行要能独立代表"这封邮件试了几次"——否则重启后光看库会以为从没试过。
   * 循环次数上界就是 maxBillRetries（默认 3），不心疼。
   */
  private catchUpRetryCount(
    store: BillNotificationStore,
    id: number,
    from: number,
    to: number,
  ): void {
    let rc = from;
    for (let i = rc; i < to; i++) {
      const next = store.incrementRetry(id);
      rc = next !== undefined && Number.isFinite(next) ? next : rc + 1;
    }
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
      for await (const msg of c.fetch([uid], query, options)) {
        if (msg) return msg as Record<string, unknown>;
        break; // 空结果同样是"没取到"，别空转整个迭代器
      }
      return null;
    }
    const msg = await c.fetchOne(String(uid), query, options);
    return msg ? (msg as Record<string, unknown>) : null;
  }

  /**
   * 处理"通知型"账单邮件：拿 ZIP → 检查解压密码 → 解压导入，全程用 notifications 表驱动重试。
   *
   * 返回值（决定要不要标记 \Seen）：
   *   'imported'      已入库           → 标记已读
   *   'no-attachment' 没有附件/抽不到下载链接 → 标记已读并提示手动导入
   *   'no-password'   缺解压密码（已发 need_password 通知）→ 不标记已读，等用户提交
   *   'error'         下载/导入失败（含密码错误）→ 不标记已读，下轮还能重试
   *   'exhausted'     密码连错到上限 → 通知转 failed 并标记已读，不再自动尝试
   *   null            这压根不是账单邮件 → 当普通未匹配邮件跳过
   *
   * 单封失败不中断整轮，错误记进 bills + stats.errors。
   */
  private async handleBillMail(
    uid: number,
    from: string,
    subject: string,
    bodyStructure: unknown,
    source: string,
  ): Promise<'imported' | 'no-attachment' | 'no-password' | 'error' | 'exhausted' | null> {
    const platform = detectBillPlatform(from, subject);
    if (!platform) return null;

    const { db, accountId, spaceId } = this.opts;
    const canImport = !!db && Number.isFinite(accountId) && (accountId as number) > 0;

    // ── ① 先只判断"背后有没有一份 ZIP 可导入"，不急着下载 ──────
    // 微信没有附件，ZIP 在正文链接后面：这里只抽链接（纯字符串操作），
    // 把几十 MB 的下载留到确认有密码之后，免得每轮轮询都白下一遍。
    const attachments = findBillAttachments(bodyStructure);
    let zipUrl: string | null = null;
    if (canImport && attachments.length === 0 && platform === 'wechat') {
      try {
        zipUrl = await this.extractWechatUrl(source);
      } catch (e: unknown) {
        this.pushBill({ from, subject, status: 'error', platform, message: errMsg(e) });
        return 'error';
      }
    }
    const hasAttachment = attachments.length > 0 && this.client !== null;
    if (!canImport || (!hasAttachment && !zipUrl)) {
      // 没有 db / 没有附件 / 微信也没抽到链接：沿用旧行为——提示一次并标记已读
      this.pushBill({
        from,
        subject,
        status: 'no-attachment',
        platform,
        hint: NO_ATTACHMENT_HINT,
      });
      return 'no-attachment';
    }

    // ── ② 密码重试状态机 ─────────────────────────────────────
    const store = await this.notifications();
    const usedRetries = await this.usedRetries(uid, store);
    // 闸门：连错到上限就不再自动解压，通知转 failed + 标记已读
    if (usedRetries >= this.maxRetries) {
      if (store) {
        const pending = await this.pendingNotification(store, uid);
        if (pending?.id !== undefined && pending.status !== 'failed') {
          store.setNotificationStatus?.(pending.id, 'failed');
        }
      }
      this.retryCounters.set(uid, usedRetries);
      this.pushBill({
        from,
        subject,
        status: 'exhausted',
        platform,
        exhausted: true,
        passwordError: true,
        remainingRetries: 0,
        message: `解压密码连续输错 ${usedRetries} 次，已停止自动尝试`,
        hint: PASSWORD_EXHAUSTED_HINT,
      });
      return 'exhausted';
    }

    const password = this.billPasswordFor(uid, platform);

    // 无密码：发 need_password 通知，**不**标记已读——下轮轮询还会回来看用户有没有提交
    if (!password) {
      this.retryCounters.set(uid, usedRetries);
      if (store) {
        const prev = await this.pendingNotification(store, uid);
        if (!prev) {
          store.createNotification({
            type: 'need_password',
            title: `检测到${platformLabel(platform)}账单，请输入解压密码`,
            message: `邮件「${subject || from}」的账单 ZIP 需要解压密码（见短信或另一封邮件）。密码仅本次有效，不会被保存。`,
            bill_uid: uid,
            platform,
          });
        }
      }
      this.pushBill({ from, subject, status: 'no-password', platform, imported: 0 });
      return 'no-password';
    }

    // ── ③ 有密码：取 ZIP → 解压导入 ──────────────────────────
    let dir: string | null = null;
    try {
      const dl = zipUrl
        ? writeZipToTempDir(uid, await this.downloader(zipUrl))
        : await downloadAttachment(this.client as ImapFlow, uid, attachments[0]);
      dir = dl.dir;
      const result = await importBillZip(
        db as Database.Database,
        dl.file,
        platform,
        password,
        accountId as number,
        spaceId,
        (n) => this.emitBillProgress(uid, platform, n),
      );
      this.retryCounters.delete(uid);
      this.forgetPassword(uid); // 一次性密码用完即焚
      if (store) {
        await this.retirePending(store, uid);
        store.createNotification({
          type: 'import_success',
          title: `${platformLabel(platform)}账单导入成功`,
          message: `已导入 ${result.imported} 笔交易（跳过 ${result.skipped} 笔）。`,
          bill_uid: uid,
          platform,
        });
      }
      this.pushBill({
        from,
        subject,
        status: 'imported',
        platform,
        imported: result.imported,
      });
      return 'imported';
    } catch (e: unknown) {
      // 非密码问题（ZIP 损坏 / CSV 认不出 / 数据库约束）：不消耗重试额度，原样报错
      const message = errMsg(e);
      if (!isPasswordError(e)) {
        this.pushBill({ from, subject, status: 'error', platform, message });
        return 'error';
      }

      // 密码错误：retry_count+1，并把"还剩几次"写进通知文案
      const attempt = usedRetries + 1;
      this.retryCounters.set(uid, attempt);
      const remaining = Math.max(0, this.maxRetries - attempt);
      let row: BillNotification | undefined;
      if (store) {
        await this.retirePending(store, uid); // 旧提示先收掉，别让用户看到两条待办
        row = store.createNotification({
          type: 'password_error',
          title: `${platformLabel(platform)}账单解压密码错误`,
          message:
            remaining > 0
              ? `密码不正确，还可以再试 ${remaining} 次。密码见申请账单时的短信或邮件。`
              : '密码错误次数过多，请手动下载账单后用 import-bill 导入。',
          bill_uid: uid,
          platform,
        });
        if (row?.id !== undefined) {
          this.catchUpRetryCount(store, row.id, row.retry_count ?? 0, attempt);
        }
      }

      if (attempt >= this.maxRetries) {
        // 到顶：通知降级为 failed（灰色、不再催）并标记已读，避免反复弹窗
        if (store && row?.id !== undefined) {
          store.setNotificationStatus?.(row.id, 'failed');
        }
        this.pushBill({
          from,
          subject,
          status: 'exhausted',
          platform,
          exhausted: true,
          passwordError: true,
          remainingRetries: 0,
          message,
          hint: PASSWORD_EXHAUSTED_HINT,
        });
        return 'exhausted';
      }

      this.pushBill({
        from,
        subject,
        status: 'error',
        platform,
        message,
        passwordError: true,
        remainingRetries: remaining,
      });
      return 'error';
    } finally {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }

  /**
   * 微信无附件账单：从正文 HTML 抽"立即下载"链接。
   * 抽不到返回 null（调用方退化成 no-attachment 提示）；提取器本身抛错则向上抛。
   */
  private async extractWechatUrl(source: string): Promise<string | null> {
    const extract = await this.wechatUrlExtractor();
    if (!extract || !source) return null;
    return safeCall(() => extract(source), null);
  }

  /** 记账本 + 广播给 CLI 的 onBill */
  private pushBill(outcome: MailBillOutcome): void {
    this.bills.push(outcome);
    this.emitBill(outcome);
  }

  private emitBillProgress(uid: number, platform: string, imported: number): void {
    try {
      this.opts.onBillProgress?.({ uid, platform, imported });
    } catch {
      /* 回调抛错不该影响轮询 */
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
      }, { uid: true });
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
          const raw = msg.source as Buffer | string | undefined;
          const source = typeof raw === 'string' ? raw : raw ? raw.toString('utf8') : '';
          const bill = await this.handleBillMail(uid, from, subject, msg.bodyStructure, source);
          // imported / no-attachment / exhausted 都是"这封邮件到此为止"→ 标记已读；
          // no-password / error 保持未读，下轮轮询还会回来看密码或重试。
          if (bill === 'imported' || bill === 'no-attachment' || bill === 'exhausted') {
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
  /** 覆盖平台默认解压密码（Map 语义同上；CLI 走的是平台级 Record） */
  billPasswords?: Map<number, string> | Record<string, string>;
  /** 通知存储；CLI 不传时由 MailPoller 软加载 */
  notifications?: BillNotificationStore;
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
    notifications: opts.notifications,
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
