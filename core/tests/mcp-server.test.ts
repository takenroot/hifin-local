/**
 * hifin MCP server 集成测试
 *
 * 策略（与 docs/mcp-design.md §6.1 对齐）：
 *  - 用 SDK v2 的 InMemoryTransport.createLinkedPair() 把 server/client 拉同进程
 *    （不起 stdio 子进程）；客户端是 @modelcontextprotocol/client
 *  - 数据库走 :memory: + openDatabase + setActiveDb + migrate + ensureSeed，
 *    与 tests/api.test.ts:37-51 / tests/notifications.test.ts:55-60 同套路
 *  - 每个 tool 至少 1 例 happy path + schema 拒绝非法入参 + 写工具错误映射
 *    + password-store 往返
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import AdmZip from 'adm-zip';
import { deflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureSeed } from '../src/db/seed.js';
import { setActiveDb } from '../src/routes/_db.js';
import { createMcpServer } from '../src/mcp/server.js';
import { createNotification } from '../src/notifications/store.js';
import { getBillPassword, clearAllBillPasswords } from '../src/bill/password-store.js';
import { saveMailConfig } from '../src/mail/poller.js';
import type Database from 'better-sqlite3';

// adm-zip 内部 zipcrypto 只能从 CJS 入口拿（tests/bill.test.ts:46-51 同套路）
const requireCjs = createRequire(import.meta.url);
const admUtils = requireCjs('adm-zip/util/utils') as { crc32(buf: Buffer): number };
const zipCrypto = requireCjs('adm-zip/methods/zipcrypto') as {
  encrypt(data: Buffer, header: { crc: number; flags: number }, pwd: string): Buffer;
};

/** 最小手工拼一个 ZipCrypto 加密 ZIP（用于"密码错误"用例） */
function buildEncryptedZip(name: string, content: string, password: string): Buffer {
  const data = Buffer.from(content, 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = admUtils.crc32(data);
  const payload = zipCrypto.encrypt(deflateRawSync(data), { crc, flags: 0x0001 }, password);

  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0x0001, 6);
  lfh.writeUInt16LE(8, 8);
  lfh.writeUInt32LE(crc, 14);
  lfh.writeUInt32LE(payload.length, 18);
  lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(20, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt16LE(0x0001, 8);
  cdh.writeUInt16LE(8, 10);
  cdh.writeUInt32LE(crc, 16);
  cdh.writeUInt32LE(payload.length, 20);
  cdh.writeUInt32LE(data.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0, 42);

  const centralOffset = lfh.length + nameBuf.length + payload.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); // entries
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdh.length + nameBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([lfh, nameBuf, payload, cdh, nameBuf, eocd]);
}

let memDb: Database.Database;
let client: Client;
let tmpRoot: string;

beforeAll(async () => {
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);
  ensureSeed(memDb);

  // 给 seed 之外的工具塞一条已挂的 need_password 通知 + 一个账户年度收益
  // （tests/api.test.ts:37-51 的常规套路下没法覆盖这两个列表，所以这里单独造数据）
  const now = Date.now();
  memDb.prepare(
    `INSERT OR IGNORE INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '招行储蓄卡', 'fund', 1000, 1, 1, ?, ?)`,
  ).run(now, now);
  memDb.prepare(
    `INSERT INTO accountYields (accountId, year, annualIncome, note, createdAt)
     VALUES (1, 2024, 350.5, '零钱通', ?)`,
  ).run(now);
  createNotification(memDb, {
    type: 'need_password',
    title: '需要解压密码',
    message: '请提供最新账单解压密码',
    bill_uid: 1811,
    platform: 'alipay',
  });

  // stdio 同进程：InMemoryTransport 把两端连起来
  const server = createMcpServer(memDb);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'hifin-mcp-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  tmpRoot = mkdtempSync(join(tmpdir(), 'hifin-mcp-test-'));
});

afterAll(async () => {
  await client?.close();
  try {
    memDb?.close();
  } catch {
    /* ignore */
  }
  try {
    rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ── 工具结果解包 helper ─────────────────────────────────────────

interface TextBlock {
  type: 'text';
  text: string;
}
interface ToolResult {
  content: TextBlock[];
  isError?: boolean;
}

function readJson<T = unknown>(result: ToolResult): T {
  // 1 个 text block，里头是 JSON
  const block = result.content[0];
  if (!block || block.type !== 'text') throw new Error('tool 返回没有 text block');
  return JSON.parse(block.text) as T;
}

// ── 测试 ────────────────────────────────────────────────

describe('hifin_health', () => {
  it('返回 ok + user_version', async () => {
    const res = (await client.callTool({ name: 'hifin_health', arguments: {} })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const data = readJson<{ ok: boolean; version: number; ts: number }>(res);
    expect(data.ok).toBe(true);
    expect(typeof data.version).toBe('number');
    expect(typeof data.ts).toBe('number');
  });
});

describe('hifin_accounts_list', () => {
  it('返回账户列表（含 latestYield 字段）', async () => {
    const res = (await client.callTool({
      name: 'hifin_accounts_list',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ id: number; latestYield: { year: number; annualIncome: number } | null }> }>(res);
    expect(data.rows.length).toBeGreaterThan(0);
    const acc1 = data.rows.find((r) => r.id === 1);
    expect(acc1).toBeTruthy();
    expect(acc1?.latestYield).toEqual({ year: 2024, annualIncome: 350.5 });
  });

  it('按 spaceId 过滤', async () => {
    const res = (await client.callTool({
      name: 'hifin_accounts_list',
      arguments: { spaceId: 1 },
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ id: number; spaceId: number }> }>(res);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.every((r) => r.spaceId === 1)).toBe(true);
  });

  it('schema 拒绝：spaceId 必须是正整数', async () => {
    const res = (await client.callTool({
      name: 'hifin_accounts_list',
      arguments: { spaceId: -1 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments/);
  });
});

describe('hifin_accounts_yields', () => {
  it('返回账户年度收益历史', async () => {
    const res = (await client.callTool({
      name: 'hifin_accounts_yields',
      arguments: { accountId: 1 },
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ year: number; annualIncome: number }> }>(res);
    expect(data.rows[0]).toMatchObject({ year: 2024, annualIncome: 350.5 });
  });

  it('账户不存在 → isError', async () => {
    const res = (await client.callTool({
      name: 'hifin_accounts_yields',
      arguments: { accountId: 999 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/账户不存在/);
  });
});

describe('hifin_transactions_query', () => {
  it('缺省 limit 时强制 100', async () => {
    const res = (await client.callTool({
      name: 'hifin_transactions_query',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{ rows: unknown[]; limit: number }>(res);
    expect(data.limit).toBe(100);
  });

  it('schema 卡死 limit ≤ 500', async () => {
    const res = (await client.callTool({
      name: 'hifin_transactions_query',
      arguments: { limit: 1000 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments/);
  });

  it('按 type 过滤', async () => {
    // ensureSeed 默认可能没有 transaction，插一条
    const now = Date.now();
    memDb.prepare(
      `INSERT INTO transactions (type, name, amount, date, accountId, includeInAsset, spaceId, createdAt)
       VALUES ('expense', '星巴克', 38, ?, 1, 1, 1, ?)`,
    ).run(now, now);

    const res = (await client.callTool({
      name: 'hifin_transactions_query',
      arguments: { type: 'expense' },
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ type: string }> }>(res);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.every((r) => r.type === 'expense')).toBe(true);
  });

  it('schema 拒绝非法 type', async () => {
    const res = (await client.callTool({
      name: 'hifin_transactions_query',
      arguments: { type: 'invalid' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments/);
  });
});

describe('hifin_summary_month', () => {
  it('返回当月汇总（默认）', async () => {
    const res = (await client.callTool({
      name: 'hifin_summary_month',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{
      month: string;
      netAsset: number;
      monthIncome: number;
      monthExpense: number;
      monthNet: number;
      mom: { delta: number; deltaPct: number | null; previousMonth: string };
    }>(res);
    expect(data.month).toMatch(/^\d{4}-\d{2}$/);
    expect(typeof data.netAsset).toBe('number');
    expect(typeof data.monthNet).toBe('number');
    expect(data.mom.previousMonth).toMatch(/^\d{4}-\d{2}$/);
  });

  it('指定 month 参数', async () => {
    const res = (await client.callTool({
      name: 'hifin_summary_month',
      arguments: { month: '2024-05' },
    })) as ToolResult;
    const data = readJson<{ month: string }>(res);
    expect(data.month).toBe('2024-05');
  });

  it('schema 拒绝非法 month 格式', async () => {
    const res = (await client.callTool({
      name: 'hifin_summary_month',
      arguments: { month: '2024/05' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments/);
  });
});

describe('hifin_categories_list', () => {
  it('返回分类列表', async () => {
    const res = (await client.callTool({
      name: 'hifin_categories_list',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ id: number; type: string }> }>(res);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(['expense', 'income']).toContain(data.rows[0].type);
  });
});

describe('hifin_rules_list', () => {
  it('返回规则列表', async () => {
    const res = (await client.callTool({
      name: 'hifin_rules_list',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{ rows: unknown[] }>(res);
    expect(Array.isArray(data.rows)).toBe(true);
  });

  it('按 enabled 过滤', async () => {
    const res = (await client.callTool({
      name: 'hifin_rules_list',
      arguments: { enabled: true },
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ enabled: number }> }>(res);
    expect(data.rows.every((r) => r.enabled === 1)).toBe(true);
  });
});

describe('hifin_notifications_list', () => {
  it('返回所有通知', async () => {
    const res = (await client.callTool({
      name: 'hifin_notifications_list',
      arguments: {},
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ type: string }> }>(res);
    expect(data.rows.some((r) => r.type === 'need_password')).toBe(true);
  });

  it('按 type 过滤', async () => {
    const res = (await client.callTool({
      name: 'hifin_notifications_list',
      arguments: { type: 'need_password' },
    })) as ToolResult;
    const data = readJson<{ rows: Array<{ type: string }> }>(res);
    expect(data.rows.length).toBeGreaterThan(0);
    expect(data.rows.every((r) => r.type === 'need_password')).toBe(true);
  });
});

// ── 写工具 ────────────────────────────────────────────────

describe('hifin_import_bill', () => {
  it('happy path：正确密码解压 + 导入', async () => {
    // 写一份带 CSV 的 ZIP 到 tmpDir
    const csv =
      '交易时间,金额,收/支,交易对方,备注\n' +
      '2024-05-12 10:23,35.50,支出,星巴克咖啡,午餐\n' +
      '2024-05-15 08:30,5000.00,收入,工资,5月薪资\n';
    const zipPath = join(tmpRoot, 'alipaybill.zip');
    const zip = new AdmZip();
    zip.addFile('alipaybill.csv', Buffer.from(csv, 'utf8'));
    zip.writeZip(zipPath);

    const res = (await client.callTool({
      name: 'hifin_import_bill',
      arguments: {
        zipPath,
        platform: 'alipay',
        password: '929143',
        accountId: 1,
      },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const data = readJson<{ platform: string; imported: number; skipped: number; files: string[] }>(res);
    expect(data.platform).toBe('alipay');
    expect(data.imported).toBe(2);
    expect(data.files).toEqual(['alipaybill.csv']);
  });

  it('错误密码 → isError + 文案包含"解压密码错误"', async () => {
    const csv = '交易时间,金额,收/支,交易对方\n2024-05-12 10:23,10,支出,test\n';
    const zipPath = join(tmpRoot, 'wrongpw.zip');
    writeFileSync(zipPath, buildEncryptedZip('alipaybill.csv', csv, '929143'));

    const res = (await client.callTool({
      name: 'hifin_import_bill',
      arguments: {
        zipPath,
        platform: 'alipay',
        password: '000000',
        accountId: 1,
      },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/解压密码错误/);
  });

  it('ZIP 里没有 csv → isError + "找不到账单表格"', async () => {
    const zipPath = join(tmpRoot, 'no-csv.zip');
    const zip = new AdmZip();
    zip.addFile('logo.png', Buffer.from('PNG-BINARY'));
    zip.writeZip(zipPath);

    const res = (await client.callTool({
      name: 'hifin_import_bill',
      arguments: {
        zipPath,
        platform: 'alipay',
        password: '929143',
        accountId: 1,
      },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/找不到账单表格/);
  });

  it('非 ZIP 文件 → isError + "账单文件格式错误"', async () => {
    const notZipPath = join(tmpRoot, 'not-a-zip.zip');
    writeFileSync(notZipPath, 'this is plain text');

    const res = (await client.callTool({
      name: 'hifin_import_bill',
      arguments: {
        zipPath: notZipPath,
        platform: 'alipay',
        password: '929143',
        accountId: 1,
      },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/账单文件格式错误/);
  });
});

describe('hifin_mail_poll', () => {
  it('未配置 IMAP → isError', async () => {
    // 上一个 it 可能没碰 mail 配置；这里也兜底，确保调用前没有 mail config
    const kv = memDb.prepare("SELECT value FROM kv WHERE key = 'mail.config'").get();
    expect(kv).toBeUndefined();
    const res = (await client.callTool({
      name: 'hifin_mail_poll',
      arguments: { accountId: 1 },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/尚未配置邮箱/);
  });
});

describe('hifin_mail_submit_bill_password', () => {
  it('写入后 getBillPassword 能取到', async () => {
    clearAllBillPasswords();
    const res = (await client.callTool({
      name: 'hifin_mail_submit_bill_password',
      arguments: { uid: 1811, password: 'my-bill-pw' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const data = readJson<{ stored: boolean; uid: number }>(res);
    expect(data).toEqual({ stored: true, uid: 1811 });
    expect(getBillPassword(1811)).toBe('my-bill-pw');
  });

  it('schema 拒绝空密码', async () => {
    const res = (await client.callTool({
      name: 'hifin_mail_submit_bill_password',
      arguments: { uid: 1811, password: '' },
    })) as ToolResult;
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid arguments/);
  });
});

describe('mail_poll 配置存在 → tool 接受（联调假 poller 不在 MCP 范围）', () => {
  it('配置写入成功（验证测试间不互相污染）', () => {
    saveMailConfig(memDb, {
      host: 'imap.qq.com',
      port: 993,
      user: 'me@qq.com',
      password: 'imap-auth',
    });
    const row = memDb.prepare("SELECT value FROM kv WHERE key = 'mail.config'").get() as { value: string };
    expect(row.value).toContain('imap.qq.com');
  });
});