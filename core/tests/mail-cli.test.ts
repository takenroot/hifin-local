/**
 * `hifin mail config` / `hifin mail poll` 编排测试
 *
 * - config：:memory: 库验证 kv 写入 / 读取，以及密码隔离存储
 *   （kv['mail.config'] 里绝不含明文密码，密码单独在 kv['mail.password']）
 * - poll：注入假 poller（不连真实 IMAP）验证 connect → poll → import → disconnect 串联
 * - MailPoller：注入假 IMAP client，验证"没有匹配 parser → 跳过并记录，不报错"
 *
 * CLI 本身不 import（cli.ts 顶层会 parseAsync(process.argv)），这里直接测它背后的编排函数。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import type { ParsedTx } from '../src/mail/parsers/base.ts';
import {
  MAIL_CONFIG_KEY,
  MAIL_PASSWORD_KEY,
  MASKED_PASSWORD,
  MailPoller,
  loadMailConfig,
  readMailPassword,
  readMaskedMailConfig,
  runMailPoll,
  saveMailConfig,
  type MailPollStats,
  type PollerLike,
} from '../src/mail/poller.ts';

const SECRET = 'imap-auth-code-9f3a2b';

function kvRaw(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
    | { value: string | null }
    | undefined;
  return row ? row.value : null;
}

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '招行卡', 'credit', 1000, 1, 1, ?, ?)`,
  ).run(now, now);
  return db;
}

// ── mail config ───────────────────────────────────────────

describe('mail config (kv 存取 + 密码隔离)', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('未配置时读取返回 null', () => {
    expect(readMaskedMailConfig(db)).toBeNull();
    expect(loadMailConfig(db)).toBeNull();
    expect(readMailPassword(db)).toBeNull();
  });

  it('写入后 kv 只有两条记录，且 config 行不含明文密码', () => {
    const view = saveMailConfig(db, {
      host: 'imap.qq.com',
      port: 993,
      user: 'me@qq.com',
      password: SECRET,
      tls: true,
    });

    expect(view.host).toBe('imap.qq.com');
    expect(view.password).toBe(MASKED_PASSWORD);

    const rows = db.prepare('SELECT key FROM kv ORDER BY key').all() as Array<{ key: string }>;
    expect(rows.map((r) => r.key)).toEqual([MAIL_CONFIG_KEY, MAIL_PASSWORD_KEY]);

    const configRaw = kvRaw(db, MAIL_CONFIG_KEY);
    expect(configRaw).toBeTruthy();
    expect(configRaw).not.toContain(SECRET);
    expect(JSON.parse(configRaw as string)).toEqual({
      host: 'imap.qq.com',
      port: 993,
      user: 'me@qq.com',
      tls: true,
      mailbox: 'INBOX',
      updatedAt: view.updatedAt,
    });

    // 密码只落在独立 key 上
    expect(kvRaw(db, MAIL_PASSWORD_KEY)).toBe(SECRET);
  });

  it('loadMailConfig 拼回完整配置（含密码），掩码视图永不泄露', () => {
    saveMailConfig(db, { host: 'imap.qq.com', port: 993, user: 'me@qq.com', password: SECRET });

    const loaded = loadMailConfig(db);
    expect(loaded).toEqual({
      host: 'imap.qq.com',
      port: 993,
      user: 'me@qq.com',
      password: SECRET,
      tls: true,
      mailbox: 'INBOX',
    });

    const masked = readMaskedMailConfig(db);
    expect(masked?.password).toBe(MASKED_PASSWORD);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  it('增量更新：省略 password 时保留已存密码', () => {
    saveMailConfig(db, { host: 'imap.qq.com', port: 993, user: 'me@qq.com', password: SECRET });
    saveMailConfig(db, { port: 143, tls: false });

    const loaded = loadMailConfig(db);
    expect(loaded?.port).toBe(143);
    expect(loaded?.tls).toBe(false);
    expect(loaded?.user).toBe('me@qq.com');
    expect(loaded?.password).toBe(SECRET);
    expect(kvRaw(db, MAIL_PASSWORD_KEY)).toBe(SECRET);
  });

  it('改密码会覆盖旧值，不会留下第二份', () => {
    saveMailConfig(db, { host: 'imap.qq.com', port: 993, user: 'me@qq.com', password: SECRET });
    saveMailConfig(db, { password: 'rotated-code' });

    expect(kvRaw(db, MAIL_PASSWORD_KEY)).toBe('rotated-code');
    expect(loadMailConfig(db)?.password).toBe('rotated-code');
    const count = (db.prepare('SELECT COUNT(*) AS c FROM kv').get() as { c: number }).c;
    expect(count).toBe(2);
  });

  it('首次配置缺 host / user / password 会报错', () => {
    expect(() => saveMailConfig(db, { port: 993, user: 'me@qq.com', password: SECRET })).toThrow(
      /--host/,
    );
    expect(() => saveMailConfig(db, { host: 'imap.qq.com', port: 993, password: SECRET })).toThrow(
      /--user/,
    );
    expect(() => saveMailConfig(db, { host: 'imap.qq.com', port: 993, user: 'me@qq.com' })).toThrow(
      /--password/,
    );
    expect(() =>
      saveMailConfig(db, { host: 'imap.qq.com', port: 0, user: 'me@qq.com', password: SECRET }),
    ).toThrow(/--port/);
  });
});

// ── mail poll（假 poller，不连真实 IMAP） ──────────────────

interface FakePoller {
  poller: PollerLike;
  calls: string[];
  daysSeen: number[];
  txsSeen: ParsedTx[][];
}

function makeFakePoller(txs: ParsedTx[], stats?: Partial<MailPollStats>): FakePoller {
  const calls: string[] = [];
  const daysSeen: number[] = [];
  const txsSeen: ParsedTx[][] = [];
  const base: MailPollStats = {
    fetched: txs.length,
    parsed: txs.length > 0 ? 1 : 0,
    transactions: txs.length,
    skipped: 0,
    errors: [],
    ...stats,
  };
  const poller: PollerLike = {
    async connect() {
      calls.push('connect');
    },
    async poll(days: number) {
      calls.push('poll');
      daysSeen.push(days);
      txsSeen.push(txs);
      return txs;
    },
    async disconnect() {
      calls.push('disconnect');
    },
    getStats: () => ({ ...base, errors: base.errors.map((e) => ({ ...e })) }),
  };
  return { poller, calls, daysSeen, txsSeen };
}

describe('mail poll 串联逻辑（mock MailPoller）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  const config = {
    host: 'imap.qq.com',
    port: 993,
    user: 'me@qq.com',
    password: SECRET,
  };

  it('connect → poll → import → disconnect，并落库 + 联动余额', async () => {
    const now = Date.now();
    const txs: ParsedTx[] = [
      { date: now - 86400_000, amount: 35.5, type: 'expense', merchant: '星巴克咖啡' },
      { date: now - 2 * 86400_000, amount: 5000, type: 'income', merchant: '工资' },
    ];
    const fake = makeFakePoller(txs, { fetched: 5, parsed: 1, skipped: 3 });

    const summary = await runMailPoll(db, {
      config,
      days: 7,
      accountId: 1,
      pollerFactory: (c) => {
        expect(c.host).toBe('imap.qq.com');
        expect(c.password).toBe(SECRET);
        return fake.poller;
      },
    });

    expect(fake.calls).toEqual(['connect', 'poll', 'disconnect']);
    expect(fake.daysSeen).toEqual([7]);
    expect(summary).toEqual({
      fetched: 5,
      parsed: 2,
      imported: 2,
      skipped: 3,
      errors: [],
    });

    const rows = db
      .prepare('SELECT name, amount, type FROM transactions ORDER BY amount')
      .all() as Array<{ name: string; amount: number; type: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].name).toBe('星巴克咖啡');
    expect(rows[1].type).toBe('income');

    // 1000 - 35.5 + 5000
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(5964.5);
  });

  it('默认 days=7，可覆盖；spaceId 透传给 importer', async () => {
    const now = Date.now();
    const fake = makeFakePoller([
      { date: now, amount: 10, type: 'expense', merchant: '便利店' },
    ]);
    await runMailPoll(db, { config, accountId: 1, pollerFactory: () => fake.poller });
    expect(fake.daysSeen).toEqual([7]);

    const fake2 = makeFakePoller([{ date: now, amount: 5, type: 'expense', merchant: '地铁' }]);
    const r = await runMailPoll(db, {
      config,
      days: 30,
      accountId: 1,
      spaceId: 7,
      pollerFactory: () => fake2.poller,
    });
    expect(fake2.daysSeen).toEqual([30]);
    expect(r.imported).toBe(1);
    const row = db.prepare('SELECT spaceId FROM transactions WHERE name = ?').get('地铁') as {
      spaceId: number;
    };
    expect(row.spaceId).toBe(7);
  });

  it('去重命中的交易计入 skipped 而非 imported', async () => {
    const now = Date.now();
    const tx: ParsedTx = { date: now, amount: 35.5, type: 'expense', merchant: '星巴克' };
    makeFakePoller([tx]);
    const first = await runMailPoll(db, { config, accountId: 1, pollerFactory: () => makeFakePoller([tx]).poller });
    expect(first).toMatchObject({ imported: 1, skipped: 0 });

    const second = await runMailPoll(db, { config, accountId: 1, pollerFactory: () => makeFakePoller([tx]).poller });
    expect(second).toMatchObject({ imported: 0, skipped: 1 });

    const c = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(c).toBe(1);
  });

  it('poller 抛出的 errors 透传到 summary（不中断导入）', async () => {
    const now = Date.now();
    const fake = makeFakePoller([{ date: now, amount: 20, type: 'expense', merchant: '咖啡' }], {
      fetched: 3,
      skipped: 1,
      errors: [{ from: 'a@b.com', subject: '账单', message: 'parse boom' }],
    });
    const summary = await runMailPoll(db, {
      config,
      accountId: 1,
      pollerFactory: () => fake.poller,
    });
    expect(summary.errors).toEqual([
      { from: 'a@b.com', subject: '账单', message: 'parse boom' },
    ]);
    expect(summary.imported).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('accountId 非法时在连 IMAP 之前就报错（factory 不被调用）', async () => {
    let built = 0;
    const factory = () => {
      built++;
      return makeFakePoller([]).poller;
    };
    await expect(
      runMailPoll(db, { config, accountId: 0, pollerFactory: factory }),
    ).rejects.toThrow(/accountId/);
    await expect(
      runMailPoll(db, { config, accountId: 1, days: 0, pollerFactory: factory }),
    ).rejects.toThrow(/days/);
    expect(built).toBe(0);
  });

  it('导入失败（账户不存在）也会 disconnect，并向上抛错', async () => {
    const fake = makeFakePoller([{ date: Date.now(), amount: 9, type: 'expense', merchant: 'x' }]);
    await expect(
      runMailPoll(db, { config, accountId: 999, pollerFactory: () => fake.poller }),
    ).rejects.toThrow(/not found/);
    expect(fake.calls).toEqual(['connect', 'poll', 'disconnect']);
  });

  it('默认 factory 不传时也不会真的去连 IMAP（连不上要抛 MailNetworkError/MailAuthError）', () => {
    // 只验证类型与实例化，不触网
    const poller = new MailPoller(config);
    expect(poller).toBeInstanceOf(MailPoller);
    expect(poller.getStats()).toEqual({
      fetched: 0,
      parsed: 0,
      transactions: 0,
      skipped: 0,
      errors: [],
    });
  });
});

// ── MailPoller.poll：无匹配 parser → 跳过并记录，不报错 ──────

interface FakeMessage {
  from: { name: string; address: string };
  subject: string;
  source: string;
}

function attachFakeClient(poller: MailPoller, messages: FakeMessage[]): { flagged: number[] } {
  const flagged: number[] = [];
  const client = {
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => messages.map((_, i) => i + 1),
    fetchOne: async (uid: string) => {
      const m = messages[Number(uid) - 1];
      if (!m) return null;
      return { envelope: { from: [m.from], subject: m.subject }, source: m.source };
    },
    messageFlagsAdd: async (uid: string) => {
      flagged.push(Number(uid));
    },
  };
  (poller as unknown as { client: unknown }).client = client;
  return { flagged };
}

describe('MailPoller.poll 跳过未匹配邮件', () => {
  const config = {
    host: 'imap.qq.com',
    port: 993,
    user: 'me@qq.com',
    password: SECRET,
  };

  it('非账单邮件计入 skipped、errors 为空，且不会被标记 \\Seen', async () => {
    const messages: FakeMessage[] = [
      {
        from: { name: '支付宝', address: 'notice@alipay.com' },
        subject: '支付宝账单',
        source: '2024-05-12 10:23 支出 35.50 元  星巴克  余额 ¥123.45',
      },
      {
        from: { name: '张三', address: 'zhangsan@qq.com' },
        subject: '周末一起吃饭？',
        source: '随便聊聊',
      },
      {
        from: { name: '未知来源', address: 'noreply@example.com' },
        subject: 'hello',
        source: 'no transactions here',
      },
    ];
    const poller = new MailPoller(config);
    const { flagged } = attachFakeClient(poller, messages);

    const txs = await poller.poll(7);
    expect(txs).toHaveLength(1);
    expect(txs[0].merchant).toBe('星巴克');
    expect(txs[0].amount).toBeCloseTo(35.5);

    const stats = poller.getStats();
    expect(stats.fetched).toBe(3);
    expect(stats.parsed).toBe(1);
    expect(stats.transactions).toBe(1);
    // 两封没有匹配 parser → 跳过，不报错
    expect(stats.skipped).toBe(2);
    expect(stats.errors).toEqual([]);

    // 只有解析出交易的邮件才标记 \Seen
    expect(flagged).toEqual([1]);
  });

  it('parser 命中但正文没有交易时也算 skipped', async () => {
    const poller = new MailPoller(config);
    attachFakeClient(poller, [
      {
        from: { name: '支付宝', address: 'notice@alipay.com' },
        subject: '支付宝账单',
        source: '这封邮件里没有交易流水',
      },
    ]);
    const txs = await poller.poll(7);
    expect(txs).toEqual([]);
    expect(poller.getStats()).toMatchObject({ fetched: 1, parsed: 0, skipped: 1, errors: [] });
  });

  it('每轮 poll 重新统计，不累计上一轮', async () => {
    const poller = new MailPoller(config);
    attachFakeClient(poller, [
      {
        from: { name: '支付宝', address: 'notice@alipay.com' },
        subject: '支付宝账单',
        source: '2024-05-12 10:23 支出 12.00 元  便利店  余额 ¥0.00',
      },
    ]);
    await poller.poll(7);
    expect(poller.getStats().fetched).toBe(1);
    await poller.poll(7);
    expect(poller.getStats().fetched).toBe(1);
    expect(poller.getStats().transactions).toBe(1);
  });

  it('未 connect 就 poll 抛 MailNetworkError', async () => {
    const poller = new MailPoller(config);
    await expect(poller.poll(7)).rejects.toThrow(/not connected/);
  });
});
