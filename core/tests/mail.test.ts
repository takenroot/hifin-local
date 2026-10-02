/**
 * IMAP 邮件账单导入模块测试
 * - parser: alipay/wechat/cmb 各 ≥ 2 个 case
 * - importer: :memory + 3 条 parsed → 3 行 + 余额联动
 * - poller: 不连真实 IMAP；仅验证 config 校验与实例化
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import {
  AlipayParser,
  WechatParser,
  CmbParser,
  detectParser,
} from '../src/mail/parsers/index.ts';
import { importTransactions } from '../src/mail/importer.ts';
import { MailPoller, MailAuthError, MailNetworkError } from '../src/mail/poller.ts';

describe('AlipayParser', () => {
  const parser = new AlipayParser();

  it('matches by from or subject', () => {
    expect(parser.match('alipay@alipay.com', '本周账单')).toBe(true);
    expect(parser.match('service@notice.com', '支付宝账单')).toBe(true);
    expect(parser.match('foo@bar.com', 'hello')).toBe(false);
  });

  it('parses expense lines', () => {
    const body = `
      2024-05-12 10:23 支出 35.50 元  星巴克  余额 ¥123.45
      2024-05-13 09:00 支出 1,200.00 元  房租  余额 ¥-50.00
    `;
    const txs = parser.parse(body);
    expect(txs).toHaveLength(2);
    expect(txs[0].type).toBe('expense');
    expect(txs[0].amount).toBeCloseTo(35.5);
    expect(txs[0].merchant).toBe('星巴克');
    expect(txs[1].amount).toBeCloseTo(1200);
  });

  it('parses income lines', () => {
    const body = '2024-06-01 12:00 收入 5,000.00 元  工资  余额 ¥5000';
    const txs = parser.parse(body);
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('income');
    expect(txs[0].amount).toBeCloseTo(5000);
    expect(txs[0].merchant).toBe('工资');
  });
});

describe('WechatParser', () => {
  const parser = new WechatParser();

  it('matches by from or subject', () => {
    expect(parser.match('wechat-pay@tencent.com', '交易提醒')).toBe(true);
    expect(parser.match('foo@bar.com', '微信支付账单 2024-05')).toBe(true);
    expect(parser.match('foo@bar.com', 'hello')).toBe(false);
  });

  it('parses expense (支付) lines', () => {
    const body = `
      2024-05-12 10:23:45 支付 ¥35.50 给商户 星巴克咖啡
      2024-05-13 09:00 支付 ¥12 给商户 便利店
    `;
    const txs = parser.parse(body);
    expect(txs).toHaveLength(2);
    expect(txs[0].type).toBe('expense');
    expect(txs[0].amount).toBeCloseTo(35.5);
    expect(txs[0].merchant).toBe('星巴克咖啡');
    expect(txs[1].amount).toBeCloseTo(12);
  });

  it('parses income (收款) lines', () => {
    const body = '2024-05-15 08:30 收款 ¥280.00 来自 张三';
    const txs = parser.parse(body);
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('income');
    expect(txs[0].amount).toBeCloseTo(280);
    expect(txs[0].merchant).toBe('张三');
  });
});

describe('CmbParser', () => {
  const parser = new CmbParser();

  it('matches by from or subject', () => {
    expect(parser.match('notice@cmbchina.com', '账户变动')).toBe(true);
    expect(parser.match('foo@bar.com', '招商银行 消费提醒')).toBe(true);
    expect(parser.match('foo@bar.com', 'hello')).toBe(false);
  });

  it('parses expense lines', () => {
    const body = `
      2024-05-12 支出 35.50 余额 1234.56 星巴克(支付宝)
      2024-05-13 支出 1,234.00 余额 0.56 超市
    `;
    const txs = parser.parse(body);
    expect(txs).toHaveLength(2);
    expect(txs[0].type).toBe('expense');
    expect(txs[0].amount).toBeCloseTo(35.5);
    expect(txs[0].merchant).toBe('星巴克(支付宝)');
    expect(txs[1].amount).toBeCloseTo(1234);
  });

  it('parses income lines', () => {
    const body = '2024-05-01 收入 5,000.00 余额 6000.00 工资';
    const txs = parser.parse(body);
    expect(txs).toHaveLength(1);
    expect(txs[0].type).toBe('income');
    expect(txs[0].amount).toBeCloseTo(5000);
    expect(txs[0].merchant).toBe('工资');
  });
});

describe('detectParser', () => {
  it('returns correct parser by from', () => {
    const p = detectParser('notice@alipay.com', 'anything');
    expect(p).toBeInstanceOf(AlipayParser);
  });
  it('returns correct parser by subject', () => {
    // 主题含 "招商银行" 但不含 "账单" → 命中 CMB
    const p = detectParser('noreply@bank.com', '招商银行 消费提醒');
    expect(p).toBeInstanceOf(CmbParser);
  });
  it('returns null for unknown', () => {
    expect(detectParser('foo@bar.com', 'hello')).toBeNull();
  });
});

describe('importTransactions', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    db.prepare(
      'INSERT INTO accounts (id, name, type, balance, includeInNetAsset, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(1, '支付宝账户', 'fund', 1000, 1, now, now);
    db.prepare(
      'INSERT INTO categories (id, name, "group", type) VALUES (?, ?, ?, ?)',
    ).run(10, '餐饮', '日常', 'expense');
    db.prepare(
      'INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    ).run('星巴克', 'merchant', 10, 100, 1, now);
  });

  it('inserts rows and updates account balance', () => {
    const now = Date.now();
    const parsed = [
      { date: now - 86400_000, amount: 35.5, type: 'expense' as const, merchant: '星巴克咖啡' },
      { date: now - 2 * 86400_000, amount: 1200, type: 'expense' as const, merchant: '房租' },
      { date: now - 3 * 86400_000, amount: 5000, type: 'income' as const, merchant: '工资' },
    ];
    const result = importTransactions(db, parsed, 1);
    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(0);

    const rows = db.prepare('SELECT type, name, amount, categoryId FROM transactions ORDER BY id').all() as Array<{
      type: string; name: string; amount: number; categoryId: number | null;
    }>;
    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe('星巴克咖啡');
    expect(rows[0].categoryId).toBe(10); // matched by rule
    expect(rows[1].categoryId).toBeNull();
    expect(rows[2].type).toBe('income');

    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    // 1000 - 35.5 - 1200 + 5000 = 4764.5
    expect(acc.balance).toBeCloseTo(4764.5);
  });

  it('skips duplicates when same amount/date/merchant', () => {
    const now = Date.now();
    const tx1 = { date: now, amount: 35.5, type: 'expense' as const, merchant: '星巴克' };
    expect(importTransactions(db, [tx1], 1).imported).toBe(1);
    const r2 = importTransactions(db, [tx1], 1);
    expect(r2.imported).toBe(0);
    expect(r2.skipped).toBe(1);
    const cnt = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(cnt).toBe(1);
  });

  it('throws on missing account', () => {
    expect(() => importTransactions(db, [], 999)).toThrow(/not found/);
  });

  it('respects spaceId option', () => {
    const now = Date.now();
    const r = importTransactions(
      db,
      [{ date: now, amount: 10, type: 'expense' as const, merchant: 'x' }],
      1,
      { spaceId: 7 },
    );
    expect(r.imported).toBe(1);
    const row = db.prepare('SELECT spaceId FROM transactions LIMIT 1').get() as { spaceId: number };
    expect(row.spaceId).toBe(7);
  });
});

describe('MailPoller', () => {
  it('throws when config missing required fields', () => {
    expect(() => new MailPoller({} as never)).toThrow();
    expect(
      () =>
          new MailPoller({
            host: 'imap.example.com',
            port: 993,
            user: 'a@b',
            password: '',
          }),
    ).toThrow(/password/);
  });

  it('throws when port invalid', () => {
    expect(
      () =>
          new MailPoller({
            host: 'imap.example.com',
            port: 0,
            user: 'a@b',
            password: 'pw',
          }),
    ).toThrow(/port/);
  });

  it('instantiates and stores config without connecting', () => {
    const p = new MailPoller({
      host: 'imap.example.com',
      port: 993,
      user: 'a@b.com',
      password: 'secret-not-leaked',
      tls: true,
      mailbox: 'INBOX',
    });
    // 静态校验：构造成功
    expect(p).toBeInstanceOf(MailPoller);
    // 关键安全校验：toString / JSON.stringify 不得泄露 password
    const s = String(p);
    expect(s.includes('secret-not-leaked')).toBe(false);
    expect(JSON.stringify(p).includes('secret-not-leaked')).toBe(false);
  });

  it('exports auth/network error classes', () => {
    expect(new MailAuthError('x')).toBeInstanceOf(Error);
    expect(new MailNetworkError('x')).toBeInstanceOf(Error);
  });
});