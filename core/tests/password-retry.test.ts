/**
 * 密码暂存 + 重试状态机 测试
 * -----------------------------------------------------------------
 * 覆盖：
 *   - PasswordStore：set/get/clear、空密码与非数字 uid 的防御、重复 set 以后者为准
 *   - handleBillMail 的重试状态机（真实 db + 真实 importBillZip，只把"密码对不对"这一步换成假实现）：
 *       无密码 → need_password 通知 + 不标记已读
 *       密码正确 → 导入 + import_success 通知 + 标记已读 + 内存密码清空
 *       密码错误 → retry_count+1 + password_error 通知（写明还剩几次）+ 密码保留
 *       连错 3 次 → 通知转 failed + 标记已读 + 之后不再尝试解压
 *       半路改对密码 → 导入成功、重试计数与旧提示一并清干净
 *   - 平台级 Record 密码（旧 CLI 语义）与 uid 精确匹配的优先级
 *
 * 为什么只 mock "密码判断"这一层：
 *   importBillZip 内部要走 adm-zip 解压 → GBK 解码 → app 的 parseCsvText → 事务落库，
 *   全 mock 掉就等于没测。真正的分支点只有一个"这个密码对不对"，所以只替换它。
 *   账单 ZIP 用 adm-zip 现造（未加密）：unzipBill 对未加密包会忽略密码，
 *   正好省掉手工拼 ZipCrypto 结构体那几十行。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { Readable } from 'node:stream';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import { BillPasswordError } from '../src/bill/unzip.ts';
import * as realStore from '../src/notifications/store.ts';
import {
  setBillPassword,
  getBillPassword,
  clearBillPassword,
  hasBillPassword,
  listBillPasswordUids,
  billPasswordCount,
  clearAllBillPasswords,
  getBillPasswordMap,
} from '../src/bill/password-store.ts';
import {
  MailPoller,
  MAX_BILL_PASSWORD_RETRIES,
  PASSWORD_EXHAUSTED_HINT,
  adaptNotificationStore,
  type BillNotification,
  type BillNotificationFilter,
  type BillNotificationInput,
  type BillNotificationStore,
  type MailBillOutcome,
} from '../src/mail/poller.ts';

// ── 只替换"密码对不对"这一步，其余全走真实实现 ────────────────

/** 测试里唯一"正确"的解压密码 */
const CORRECT_PASSWORD = '929143';
/** 每次调用都会记录参数，用于断言"到底尝试了几次" */
const importBillZipMock = vi.fn();

vi.mock('../src/bill/importer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/bill/importer.ts')>();
  return {
    ...actual,
    importBillZip: (
      db: Parameters<typeof actual.importBillZip>[0],
      zip: string,
      platform: string,
      password: string,
      accountId: number,
      spaceId?: number,
      onProgress?: (n: number) => void,
    ) => {
      importBillZipMock({ db, zip, platform, password, accountId, spaceId, onProgress });
      if (password !== CORRECT_PASSWORD) {
        return Promise.reject(new BillPasswordError('解压密码错误（测试构造）'));
      }
      return actual.importBillZip(db, zip, platform, password, accountId, spaceId, onProgress);
    },
  };
});

// ── 内存版通知 store（不碰 SQLite，行为对齐 notifications 表） ──

function makeNotificationStore(): BillNotificationStore & { rows: BillNotification[] } {
  const rows: BillNotification[] = [];
  let nextId = 1;
  return {
    rows,
    createNotification(input: BillNotificationInput): BillNotification {
      const row: BillNotification = {
        id: nextId++,
        type: input.type,
        title: input.title,
        message: input.message,
        bill_uid: input.bill_uid,
        platform: input.platform,
        status: 'pending',
        retry_count: 0,
      };
      rows.push(row);
      return row;
    },
    listNotifications(filter?: BillNotificationFilter): BillNotification[] {
      return rows.filter(
        (r) =>
          (!filter?.status || r.status === filter.status) &&
          (!filter?.type || r.type === filter.type) &&
          (filter?.bill_uid === undefined || r.bill_uid === filter.bill_uid),
      );
    },
    incrementRetry(id: number): number {
      const row = rows.find((r) => r.id === id);
      if (!row) return 0;
      row.retry_count += 1;
      return row.retry_count;
    },
    resolveNotification(id: number): void {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = 'resolved';
    },
    setNotificationStatus(id: number, status: BillNotification['status']): void {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = status;
    },
  };
}

// ── 账单 ZIP + 假 IMAP client ────────────────────────────────

/** 2 笔有效 + 1 笔不计收支 */
const BILL_CSV = [
  '交易时间,金额,收/支,交易对方,备注',
  '2024-05-12 10:23,35.50,支出,星巴克咖啡,午餐',
  '2024-05-13 09:00,1200.00,支出,房租,5月房租',
  '2024-05-16 12:00,,不计,余额宝,自动转入',
  '',
].join('\n');

/** 现造一个未加密的账单 ZIP；unzipBill 对未加密包会忽略密码参数 */
function makeBillZip(): Buffer {
  const zip = new AdmZip();
  zip.addFile('alipaybill.csv', Buffer.from(BILL_CSV, 'utf8'));
  return zip.toBuffer();
}

const ALIPAY_BODY = {
  type: 'multipart/mixed',
  part: '1',
  childNodes: [
    { type: 'text/plain', part: '1.1' },
    {
      type: 'application/zip',
      part: '1.2',
      disposition: 'attachment',
      dispositionParameters: { filename: 'alipaybill.zip' },
    },
  ],
};

const POLLER_CONFIG = {
  host: 'imap.qq.com',
  port: 993,
  user: 'me@qq.com',
  password: 'imap-auth-code',
};

interface FakeBillMail {
  from: { name: string; address: string };
  subject: string;
  source: string;
  bodyStructure?: unknown;
}

const ALIPAY_MAIL: FakeBillMail = {
  from: { name: '支付宝', address: 'notice@alipay.com' },
  subject: '你的账单文件已生成',
  source: '账单文件已生成，请下载查阅。',
  bodyStructure: ALIPAY_BODY,
};

/** 内存库 + 一个 id=1 的账户（importTransactions 要求目标账户存在） */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '支付宝', 'fund', 1000, 1, 1, ?, ?)`,
  ).run(now, now);
  return db;
}

/** 装一个假 IMAP client，下载固定返回给定的 ZIP 字节 */
function attachClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poller: any,
  mail: FakeBillMail,
  zip: Buffer | null,
): { flagged: number[] } {
  const flagged: number[] = [];
  poller.client = {
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => [1811],
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetch() {
      yield {
        envelope: { from: [mail.from], subject: mail.subject },
        source: Buffer.from(mail.source),
        bodyStructure: mail.bodyStructure,
      };
    },
    async fetchOne() {
      return false;
    },
    async download() {
      if (!zip) return { content: undefined };
      return { meta: { filename: 'alipaybill.zip' }, content: Readable.from([zip]) };
    },
    async messageFlagsAdd(uid: string) {
      flagged.push(Number(uid));
    },
  };
  return { flagged };
}

/** 造一个只针对单封账单邮件的 poller，附带收集器 */
function makePoller(
  db: Database.Database,
  opts: {
    passwords: Map<number, string> | Record<string, string>;
    notifications: BillNotificationStore;
    zip?: Buffer | null;
    mail?: FakeBillMail;
    extractWechatUrl?: (html: string) => string | null;
    downloadBillZip?: (url: string) => Promise<Buffer>;
  },
) {
  const outcomes: MailBillOutcome[] = [];
  const progress: Array<{ uid: number; platform: string; imported: number }> = [];
  const poller = new MailPoller(POLLER_CONFIG, {
    db,
    accountId: 1,
    spaceId: 1,
    billPasswords: opts.passwords,
    notifications: opts.notifications,
    extractWechatUrl: opts.extractWechatUrl,
    downloadBillZip: opts.downloadBillZip,
    onBill: (o) => outcomes.push(o),
    onBillProgress: (p) => progress.push(p),
  });
  const zip = opts.zip === undefined ? makeBillZip() : opts.zip;
  const { flagged } = attachClient(poller, opts.mail ?? ALIPAY_MAIL, zip);
  return { poller, outcomes, progress, flagged };
}

function txCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
}

// ── 1. PasswordStore ─────────────────────────────────────────

describe('PasswordStore（内存暂存，不持久化）', () => {
  afterEach(() => clearAllBillPasswords());

  it('set → get → clear 走通一轮', () => {
    expect(getBillPassword(1811)).toBeUndefined();
    setBillPassword(1811, CORRECT_PASSWORD);
    expect(getBillPassword(1811)).toBe(CORRECT_PASSWORD);
    expect(hasBillPassword(1811)).toBe(true);
    clearBillPassword(1811);
    expect(getBillPassword(1811)).toBeUndefined();
    expect(hasBillPassword(1811)).toBe(false);
  });

  it('同一 uid 重复 set 以最后一次为准（用户改密码后重输是常态）', () => {
    setBillPassword(1811, '000000');
    setBillPassword(1811, CORRECT_PASSWORD);
    expect(getBillPassword(1811)).toBe(CORRECT_PASSWORD);
    expect(billPasswordCount()).toBe(1);
  });

  it('多 uid 互不干扰，listBillPasswordUids 按升序', () => {
    setBillPassword(20, 'b');
    setBillPassword(3, 'a');
    expect(listBillPasswordUids()).toEqual([3, 20]);
    clearBillPassword(3);
    expect(listBillPasswordUids()).toEqual([20]);
  });

  it('空密码 / 非数字 uid 直接拒绝（别让 NaN 变成取不到密码的幽灵键）', () => {
    expect(() => setBillPassword(1811, '')).toThrow(/不能为空/);
    expect(() => setBillPassword(Number.NaN, 'x')).toThrow(/必须是数字/);
    expect(getBillPassword(Number.NaN)).toBeUndefined();
    expect(clearBillPassword(Number.NaN)).toBeUndefined();
  });

  it('getBillPasswordMap 暴露的就是共享那份 Map（接口写入 → poller 读出）', () => {
    const shared = getBillPasswordMap();
    setBillPassword(1811, CORRECT_PASSWORD);
    expect(shared.get(1811)).toBe(CORRECT_PASSWORD);
    clearBillPassword(1811);
    expect(shared.has(1811)).toBe(false);
  });
});

// ── 2. 密码重试状态机 ────────────────────────────────────────

describe('MailPoller 密码重试状态机', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    importBillZipMock.mockClear();
  });

  it('无密码 → need_password 通知 + 不标记已读 + 压根不碰解压', async () => {
    const notif = makeNotificationStore();
    const { poller, outcomes, flagged } = makePoller(db, { passwords: new Map(), notifications: notif });

    await poller.poll(7);

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ status: 'no-password', platform: 'alipay', imported: 0 });
    expect(flagged).toEqual([]); // 等密码，不能标记已读
    expect(importBillZipMock).not.toHaveBeenCalled();

    const rows = notif.listNotifications({ status: 'pending' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'need_password', bill_uid: 1811, platform: 'alipay', retry_count: 0 });
    expect(rows[0].title).toMatch(/支付宝/);
    expect(txCount(db)).toBe(0);
  });

  it('拿到密码 → 导入成功 → import_success 通知 + 标记已读 + 内存密码清空', async () => {
    const notif = makeNotificationStore();
    const passwords = new Map<number, string>();
    setBillPassword(1811, CORRECT_PASSWORD);
    passwords.set(1811, CORRECT_PASSWORD);
    const { poller, outcomes, progress, flagged } = makePoller(db, { passwords, notifications: notif });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({ status: 'imported', platform: 'alipay', imported: 2 });
    expect(flagged).toEqual([1811]); // 入库完成才算处理完
    expect(txCount(db)).toBe(2);
    expect(passwords.has(1811)).toBe(false); // 一次性密码用完即焚
    expect(progress).toEqual([{ uid: 1811, platform: 'alipay', imported: 2 }]);

    const pending = notif.listNotifications({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ type: 'import_success' });
    expect(pending[0].message).toMatch(/已导入 2 笔/);
  });

  it('密码错误 → retry_count+1 + password_error 通知（写明还剩几次）+ 密码保留 + 不标记已读', async () => {
    const notif = makeNotificationStore();
    const passwords = new Map<number, string>([[1811, '000000']]);
    const { poller, outcomes, flagged } = makePoller(db, { passwords, notifications: notif });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({
      status: 'error',
      passwordError: true,
      remainingRetries: MAX_BILL_PASSWORD_RETRIES - 1,
    });
    expect(flagged).toEqual([]);
    expect(txCount(db)).toBe(0);
    expect(passwords.get(1811)).toBe('000000'); // 密码留着，下轮用同一个再试

    const rows = notif.listNotifications({ bill_uid: 1811 });
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ type: 'password_error', status: 'pending', retry_count: 1 });
    expect(last.message).toMatch(/还可以再试 2 次/);
  });

  it('连错 3 次 → 通知转 failed + 标记已读，第 4 次起不再尝试解压', async () => {
    const notif = makeNotificationStore();
    const passwords = new Map<number, string>([[1811, '000000']]);
    const { poller, outcomes, flagged } = makePoller(db, { passwords, notifications: notif });

    // 第 1、2 次：还剩机会，保持未读
    for (const expected of [1, 2]) {
      await poller.poll(7);
      expect(outcomes[outcomes.length - 1]).toMatchObject({
        status: 'error',
        passwordError: true,
        remainingRetries: MAX_BILL_PASSWORD_RETRIES - expected,
      });
      expect(flagged).toEqual([]);
    }
    expect(importBillZipMock).toHaveBeenCalledTimes(2);

    // 第 3 次：到顶 → exhausted，标记已读，通知降级为 failed
    await poller.poll(7);
    expect(outcomes[outcomes.length - 1]).toMatchObject({
      status: 'exhausted',
      exhausted: true,
      passwordError: true,
      remainingRetries: 0,
      hint: PASSWORD_EXHAUSTED_HINT,
    });
    expect(flagged).toEqual([1811]);
    expect(importBillZipMock).toHaveBeenCalledTimes(3);

    const last = notif.listNotifications({ bill_uid: 1811 }).pop()!;
    expect(last).toMatchObject({ type: 'password_error', status: 'failed', retry_count: 3 });
    expect(last.message).toMatch(/手动/);
    // failed 的通知不再出现在待办列表里 → 不会反复弹窗
    expect(notif.listNotifications({ status: 'pending' })).toHaveLength(0);

    // 第 4 次：闸门拦下，一次解压都不再发生
    await poller.poll(7);
    expect(importBillZipMock).toHaveBeenCalledTimes(3);
    expect(outcomes[outcomes.length - 1]).toMatchObject({ status: 'exhausted' });
  });

  it('半路改对密码 → 导入成功，旧提示被收掉、重试计数清零', async () => {
    const notif = makeNotificationStore();
    const passwords = new Map<number, string>([[1811, '000000']]);
    const { poller, outcomes, flagged } = makePoller(db, { passwords, notifications: notif });

    await poller.poll(7); // 第 1 次：密码错
    await poller.poll(7); // 第 2 次：还是错
    expect(notif.listNotifications({ status: 'pending' })).toHaveLength(1);

    passwords.set(1811, CORRECT_PASSWORD); // 用户这次输对了
    await poller.poll(7);

    expect(outcomes[outcomes.length - 1]).toMatchObject({ status: 'imported', imported: 2 });
    expect(flagged).toEqual([1811]);
    expect(txCount(db)).toBe(2);

    // 旧的 password_error 提示被收掉（dismissed），待办里只剩 import_success
    const pending = notif.listNotifications({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0].type).toBe('import_success');
    expect(notif.listNotifications({ status: 'dismissed' }).map((r) => r.type)).toEqual([
      'password_error',
      'password_error',
    ]);

    // 计数已清零：再有一封新邮件不会继承上一封的重试额度
    expect(importBillZipMock).toHaveBeenCalledTimes(3);
  });

  it('统计口径不变：非 imported 的账单邮件一律计入 skipped', async () => {
    const notif = makeNotificationStore();
    const { poller } = makePoller(db, { passwords: new Map(), notifications: notif });

    await poller.poll(7);

    const stats = poller.getStats();
    expect(stats).toMatchObject({ fetched: 1, parsed: 0, skipped: 1, errors: [] });
    // 缺密码不是"系统错误"，不该污染 errors（用户去补密码就行）
    expect(poller.getBillOutcomes()[0].status).toBe('no-password');
  });
});

// ── 3. 密码来源的两种语义 ────────────────────────────────────

describe('billPasswords 的 uid 精确匹配与平台兜底', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    importBillZipMock.mockClear();
  });

  it('密码按 uid 精确匹配：A 封邮件的密码不能拿去解锁 B 封', async () => {
    const notif = makeNotificationStore();
    // 存的是另一封邮件的密码；本封（uid 1811）视为没密码
    const passwords = new Map<number, string>([[9999, CORRECT_PASSWORD]]);
    const { poller, outcomes, flagged } = makePoller(db, { passwords, notifications: notif });

    await poller.poll(7);

    expect(outcomes[0].status).toBe('no-password');
    expect(importBillZipMock).not.toHaveBeenCalled();
    expect(flagged).toEqual([]);
    expect(notif.listNotifications({ bill_uid: 1811 })[0].type).toBe('need_password');
    // 别人的密码不能被顺手清掉
    expect(passwords.get(9999)).toBe(CORRECT_PASSWORD);
  });

  it('平台级 Record 仍然可用（CLI --bill-password-alipay 走这条路）', async () => {
    const notif = makeNotificationStore();
    const { poller, outcomes, flagged } = makePoller(db, {
      passwords: { alipay: CORRECT_PASSWORD },
      notifications: notif,
    });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({ status: 'imported', imported: 2 });
    expect(flagged).toEqual([1811]);
  });

  it('没有 db → 只提示、不导入、不产生通知（不误写库）', async () => {
    const notif = makeNotificationStore();
    const outcomes: MailBillOutcome[] = [];
    const poller = new MailPoller(POLLER_CONFIG, {
      billPasswords: new Map([[1811, CORRECT_PASSWORD]]),
      notifications: notif,
      onBill: (o) => outcomes.push(o),
    });
    attachClient(poller, ALIPAY_MAIL, makeBillZip());

    await poller.poll(7);

    expect(outcomes[0].status).toBe('no-attachment');
    expect(importBillZipMock).not.toHaveBeenCalled();
    expect(notif.rows).toHaveLength(0);
  });
});

// ── 4. 微信无附件：从正文抽下载链接再走同一套密码流程 ──────────

/** 微信通知信：正文只有"立即下载"，BODYSTRUCTURE 里没有任何附件 */
const WECHAT_MAIL: FakeBillMail = {
  from: { name: '微信支付', address: 'wxpay@tencent.com' },
  subject: '微信支付账单',
  source: '<html><body>你的账单已生成，<a href="https://pay.weixin.qq.com/bill/download?token=abc">立即下载</a></body></html>',
  bodyStructure: { type: 'text/html', part: '1' },
};

const WECHAT_URL = 'https://pay.weixin.qq.com/bill/download?token=abc';

describe('微信无附件账单邮件（抽 URL → 下载 ZIP → 走同一套密码流程）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
    importBillZipMock.mockClear();
  });

  it('抽到链接 → 下载 ZIP → 有密码则直接导入', async () => {
    const notif = makeNotificationStore();
    const requested: string[] = [];
    const { poller, outcomes, flagged } = makePoller(db, {
      passwords: new Map([[1811, CORRECT_PASSWORD]]),
      notifications: notif,
      mail: WECHAT_MAIL,
      extractWechatUrl: (html) => (html.includes('立即下载') ? WECHAT_URL : null),
      downloadBillZip: async (url) => {
        requested.push(url);
        return makeBillZip();
      },
    });

    await poller.poll(7);

    expect(requested).toEqual([WECHAT_URL]);
    expect(outcomes[0]).toMatchObject({ status: 'imported', platform: 'wechat', imported: 2 });
    expect(flagged).toEqual([1811]);
    expect(txCount(db)).toBe(2);
  });

  it('抽到链接但没密码 → 同样是 need_password，不标记已读、也不白下几十 MB', async () => {
    const notif = makeNotificationStore();
    let downloads = 0;
    const { poller, outcomes, flagged } = makePoller(db, {
      passwords: new Map(),
      notifications: notif,
      mail: WECHAT_MAIL,
      extractWechatUrl: () => WECHAT_URL,
      downloadBillZip: async () => {
        downloads += 1;
        return makeBillZip();
      },
    });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({ status: 'no-password', platform: 'wechat' });
    expect(flagged).toEqual([]);
    expect(notif.listNotifications({ bill_uid: 1811 })[0].title).toMatch(/微信/);
    // 没有密码就解压不了，没必要先把 ZIP 拉下来
    expect(downloads).toBe(0);
  });

  it('抽不到链接 → 退回 no-attachment 提示并标记已读', async () => {
    const notif = makeNotificationStore();
    const { poller, outcomes, flagged } = makePoller(db, {
      passwords: new Map([[1811, CORRECT_PASSWORD]]),
      notifications: notif,
      mail: WECHAT_MAIL,
      extractWechatUrl: () => null,
      downloadBillZip: async () => makeBillZip(),
    });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({ status: 'no-attachment', platform: 'wechat' });
    expect(flagged).toEqual([1811]);
    expect(importBillZipMock).not.toHaveBeenCalled();
    expect(notif.rows).toHaveLength(0);
  });

  it('ZIP 下载失败 → error + 不标记已读，且不消耗密码重试额度', async () => {
    const notif = makeNotificationStore();
    const { poller, outcomes, flagged } = makePoller(db, {
      passwords: new Map([[1811, CORRECT_PASSWORD]]),
      notifications: notif,
      mail: WECHAT_MAIL,
      extractWechatUrl: () => WECHAT_URL,
      downloadBillZip: async () => {
        throw new Error('账单 ZIP 下载失败: HTTP 403');
      },
    });

    await poller.poll(7);

    expect(outcomes[0]).toMatchObject({ status: 'error', platform: 'wechat' });
    expect(outcomes[0].message).toMatch(/HTTP 403/);
    expect(flagged).toEqual([]);
    // 下载问题跟密码无关：没发通知，重试计数也没动
    expect(notif.rows).toHaveLength(0);
    expect(importBillZipMock).not.toHaveBeenCalled();
  });

  it('支付宝无附件邮件不做 URL 抽取（只有微信走这条路）', async () => {
    const notif = makeNotificationStore();
    let extractorCalls = 0;
    const { poller, outcomes } = makePoller(db, {
      passwords: new Map([[1811, CORRECT_PASSWORD]]),
      notifications: notif,
      mail: { ...ALIPAY_MAIL, bodyStructure: { type: 'text/plain', part: '1' } },
      extractWechatUrl: () => {
        extractorCalls += 1;
        return WECHAT_URL;
      },
      downloadBillZip: async () => makeBillZip(),
    });

    await poller.poll(7);

    expect(extractorCalls).toBe(0);
    expect(outcomes[0]).toMatchObject({ status: 'no-attachment', platform: 'alipay' });
  });
});

// ── 5. 与真 notifications/store.js 对接 ───────────────────────

describe('adaptNotificationStore 对接真 store', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = makeDb();
    importBillZipMock.mockClear();
  });

  function rows(): Array<Record<string, unknown>> {
    return db.prepare('SELECT * FROM notifications ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
  }

  it('真 store 的 db-first 签名被正确绑定，写进去的就是真表', () => {
    const store = adaptNotificationStore(realStore, db)!;
    expect(store).not.toBeNull();

    const created = store.createNotification({
      type: 'need_password',
      title: '需要密码',
      bill_uid: 1811,
      platform: 'alipay',
    });
    expect(created?.id).toBeGreaterThan(0);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      type: 'need_password',
      bill_uid: 1811,
      status: 'pending',
      retry_count: 0,
    });
  });

  it('listNotifications 的 bill_uid 是客户端过滤（真 store 只认 status/type）', () => {
    const store = adaptNotificationStore(realStore, db)!;
    store.createNotification({ type: 'need_password', title: 'A', bill_uid: 111 });
    store.createNotification({ type: 'need_password', title: 'B', bill_uid: 222 });
    store.createNotification({ type: 'import_success', title: 'C', bill_uid: 111 });

    expect(store.listNotifications()).toHaveLength(3);
    // 真 store 按 createdAt DESC / id DESC 返回（新的在前），这里只关心筛得对不对
    expect(store.listNotifications({ bill_uid: 111 }).map((r) => r.title).sort()).toEqual(['A', 'C']);
    expect(store.listNotifications({ bill_uid: 999 })).toHaveLength(0);
    expect(store.listNotifications({ status: 'pending' })).toHaveLength(3);
    expect(store.listNotifications({ status: 'resolved' })).toHaveLength(0);
  });

  it('incrementRetry / setNotificationStatus 落到真表', () => {
    const store = adaptNotificationStore(realStore, db)!;
    const created = store.createNotification({
      type: 'password_error',
      title: '密码错',
      bill_uid: 1811,
    })!;

    expect(store.incrementRetry(created.id!)).toBe(1);
    expect(store.incrementRetry(created.id!)).toBe(2);
    expect(rows()[0].retry_count).toBe(2);

    store.setNotificationStatus!(created.id!, 'dismissed');
    expect(rows()[0].status).toBe('dismissed');
  });

  it('端到端：poller 不注入通知 store，靠软加载真 store 跑完 3 次重试', async () => {
    const passwords = new Map<number, string>([[1811, '000000']]);
    const outcomes: MailBillOutcome[] = [];
    const poller = new MailPoller(POLLER_CONFIG, {
      db,
      accountId: 1,
      spaceId: 1,
      billPasswords: passwords,
      onBill: (o) => outcomes.push(o),
    });
    attachClient(poller, ALIPAY_MAIL, makeBillZip());

    for (let i = 0; i < 3; i++) await poller.poll(7);

    const written = rows();
    expect(written).toHaveLength(3); // 三次密码错误各留一条记录
    expect(written.map((r) => r.type)).toEqual([
      'password_error',
      'password_error',
      'password_error',
    ]);
    // 累计重试次数被补齐到 1/2/3，库里读得出"这封邮件试了几次"
    expect(written.map((r) => r.retry_count)).toEqual([1, 2, 3]);
    // 到顶那条被移出待办列表，不会反复弹窗
    expect(written.filter((r) => r.status === 'pending')).toHaveLength(0);
    expect(outcomes[outcomes.length - 1]).toMatchObject({ status: 'exhausted' });
  });
});
