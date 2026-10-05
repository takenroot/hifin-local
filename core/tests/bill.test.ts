/**
 * 账单 ZIP 解压导入 MVP 测试
 * -----------------------------------------------------------------
 * 覆盖：
 *   - unzipBill：正确密码解压成功 / 错误密码抛错 / 非 ZIP / 无 CSV
 *   - findBillCsv：.csv 优先于 .txt，跳过 __MACOSX 等垃圾条目
 *   - importBillZip：落库行数、余额联动、跳过计数、规则分类、空间 ID
 *   - CLI `hifin import-bill`：起子进程跑完整流程
 *   - 邮件附件识别：bodyStructure 里的 zip/octet-stream 部件 + 平台猜测
 *
 * 关于加密 ZIP 的构造：
 *   adm-zip 只能"解"不能"加"密——addFile() 没有密码参数，写出来的包
 *   encrypted 标志位恒为 0（已实测）。而 adm-zip 内部 methods/zipcrypto.js
 *   提供了完整的 ZipCrypto 加解密原语，所以这里手工拼 ZIP 结构体（本地文件头
 *   / 中央目录 / EOCD）+ zlib deflateRaw + zipcrypto.encrypt，生成一个真正的
 *   带密码 ZIP —— 这样测的才是 unzipBill 的真实解密路径，而不是"没加密也能过"。
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import {
  unzipBill,
  findBillCsv,
  isZipFile,
  cleanupBillDir,
  BillPasswordError,
  BillFormatError,
  BillCsvNotFoundError,
} from '../src/bill/unzip.ts';
import { importBillZip } from '../src/bill/importer.ts';
import { findBillAttachments, detectBillPlatform, NO_ATTACHMENT_HINT, MailPoller } from '../src/mail/poller.ts';

// adm-zip 的内部模块只有 CJS，用 createRequire 拿
const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const admUtils = requireCjs('adm-zip/util/utils') as { crc32(buf: Buffer): number };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const zipCrypto = requireCjs('adm-zip/methods/zipcrypto') as {
  encrypt(data: Buffer, header: { crc: number; flags: number }, pwd: string): Buffer;
  decrypt(data: Buffer, header: { crc: number; flags: number }, pwd: string): Buffer;
};

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(CORE_ROOT, 'src', 'cli.ts');
const TSX = join(CORE_ROOT, 'node_modules', '.bin', 'tsx');

const ALIPAY_PASSWORD = "929143"; // 测试用密码
const WECHAT_PASSWORD = "362502"; // 测试用密码

/** 3 笔有效 + 1 笔不计收支 + 1 笔金额非法 */
const ALIPAY_CSV = [
  '交易时间,金额,收/支,交易对方,备注',
  '2024-05-12 10:23,35.50,支出,星巴克咖啡,午餐',
  '2024-05-13 09:00,1200.00,支出,房租,5月房租',
  '2024-05-15 08:30,5000.00,收入,工资,5月薪资',
  '2024-05-16 12:00,,不计,余额宝,自动转入',
  '2024-05-17 12:00,abc,支出,坏行,金额无法解析',
  '',
].join('\n');

const WECHAT_CSV = [
  '交易时间,金额,收/支,交易对方,备注',
  '2024-06-01 12:00,88.80,支出,盒马鲜生,买菜',
  '2024-06-02 19:30,25.00,支出,瑞幸咖啡,下午茶',
  '',
].join('\n');

// ── 测试脚手架 ──────────────────────────────────────────────

// 注意：这里刻意避开 hifin-bill- 前缀——那是 unzipBill 自建临时目录的标记，
// 本测试根目录若撞上它，cleanupBillDir 的"只删自建目录"保护就测不到了。
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'hifin-test-'));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));

let seq = 0;
/** 每次调用给一个独立的临时路径，避免用例之间互相覆盖 */
function tmpPath(name: string): string {
  seq += 1;
  return join(TMP_ROOT, `${seq}-${name}`);
}

/** 内存库 + 一个 id=1、余额 1000 的账户 */
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

/** 跑 CLI，返回解析后的 stdout JSON（失败即抛，含 stderr 便于定位） */
function runCli(args: string[]): unknown {
  const stdout = execFileSync(TSX, [CLI, ...args], {
    cwd: CORE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(stdout);
}

/** 跑 CLI 并期望失败 */
function runCliExpectFail(args: string[]): { status: number; stderr: string } {
  try {
    execFileSync(TSX, [CLI, ...args], {
      cwd: CORE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: unknown) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? -1, stderr: err.stderr ?? '' };
  }
  throw new Error('期望 CLI 失败，但它成功了');
}

// ── 加密 ZIP 构造器 ─────────────────────────────────────────

interface ZipEntryInput {
  name: string;
  content: string;
}

/**
 * 手工拼一个 ZipCrypto 加密的 ZIP。
 * 结构：每个条目 [本地文件头][加密数据]，末尾 [中央目录][EOCD]。
 * 加密数据 = zipcrypto.encrypt(deflateRaw(明文), {crc, flags: 0x0001}, 密码)，
 * 头 12 字节是校验头（末字节存 crc 高 8 位，adm-zip 靠它判断密码对不对）。
 */
function buildEncryptedZip(entries: ZipEntryInput[], password: string): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const { name, content } of entries) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = admUtils.crc32(data);
    const payload = zipCrypto.encrypt(deflateRawSync(data), { crc, flags: 0x0001 }, password);

    // 本地文件头：30 字节定长
    const lfh = Buffer.alloc(30);
    lfh.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    lfh.writeUInt16LE(20, 4); // version needed
    lfh.writeUInt16LE(0x0001, 6); // 标志位 bit0 = 加密
    lfh.writeUInt16LE(8, 8); // method = deflate
    lfh.writeUInt16LE(0, 10); // mod time
    lfh.writeUInt16LE(0x2821, 12); // mod date（固定值，测试不关心）
    lfh.writeUInt32LE(crc, 14);
    lfh.writeUInt32LE(payload.length, 18); // 含 12 字节加密头
    lfh.writeUInt32LE(data.length, 22);
    lfh.writeUInt16LE(nameBuf.length, 26);
    lfh.writeUInt16LE(0, 28); // extra length
    parts.push(lfh, nameBuf, payload);

    // 中央目录头：46 字节定长
    const cdh = Buffer.alloc(46);
    cdh.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    cdh.writeUInt16LE(20, 4); // version made by
    cdh.writeUInt16LE(20, 6); // version needed
    cdh.writeUInt16LE(0x0001, 8); // 标志位 bit0 = 加密
    cdh.writeUInt16LE(8, 10);
    cdh.writeUInt16LE(0, 12);
    cdh.writeUInt16LE(0x2821, 14);
    cdh.writeUInt32LE(crc, 16);
    cdh.writeUInt32LE(payload.length, 20);
    cdh.writeUInt32LE(data.length, 24);
    cdh.writeUInt16LE(nameBuf.length, 28);
    cdh.writeUInt16LE(0, 30); // extra
    cdh.writeUInt16LE(0, 32); // comment
    cdh.writeUInt16LE(0, 34); // disk number start
    cdh.writeUInt16LE(0, 36); // internal attrs
    cdh.writeUInt32LE(0, 38); // external attrs
    cdh.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cdh, nameBuf);

    offset += lfh.length + nameBuf.length + payload.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...parts, centralBuf, eocd]);
}

/** 写一个加密 ZIP 到磁盘，返回路径 */
function writeEncryptedZip(name: string, entries: ZipEntryInput[], password: string): string {
  const p = tmpPath(name);
  writeFileSync(p, buildEncryptedZip(entries, password));
  return p;
}

/** 写一个不加密的 ZIP（用 adm-zip 自己写） */
function writePlainZip(name: string, entries: ZipEntryInput[]): string {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, Buffer.from(e.content, 'utf8'));
  const p = tmpPath(name);
  zip.writeZip(p);
  return p;
}

/**
 * 从磁盘上的加密 ZIP 里取出第一个条目的加密数据与头字段。
 *
 * 判定"某密码有没有蒙过 verification byte"必须用和 unzipBill 完全相同的那批字节，
 * 所以这里从文件里读，而不是复用构造过程——ZipCrypto 的 salt 每次加密都随机生成，
 * 写死密码名单只会得到一个碰运气、甚至悄悄失效的测试。
 */
function readFirstEncryptedEntry(encryptedZip: string): {
  payload: Buffer;
  header: { crc: number; flags: number };
} {
  const buf = readFileSync(encryptedZip);
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error('不是本地文件头，测试数据构造有误');
  const flags = buf.readUInt16LE(6);
  const crc = buf.readUInt32LE(14);
  const compSize = buf.readUInt32LE(18); // 含 12 字节加密头
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28); // 30 + 文件名 + extra
  return { payload: buf.subarray(start, start + compSize), header: { crc, flags } };
}

/**
 * 该密码是否恰好蒙过 ZipCrypto 的 1 字节 verification byte 校验。
 * 过了校验，adm-zip 就认定密码正确并把（乱码）交给 zlib——这正是 ISSUE-003 的入口。
 */
function passesZipCryptoVerification(
  payload: Buffer,
  header: { crc: number; flags: number },
  pwd: string,
): boolean {
  try {
    zipCrypto.decrypt(payload, header, pwd);
    return true; // 没抛 WRONG_PASSWORD 就是过了
  } catch {
    return false;
  }
}

// ── unzipBill ───────────────────────────────────────────────

describe('unzipBill', () => {
  it('正确密码解压成功，文件内容逐字节一致', () => {
    const zip = writeEncryptedZip('alipay.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const files = unzipBill(zip, ALIPAY_PASSWORD);

    expect(files).toHaveLength(1);
    expect(files[0].endsWith('alipaybill.csv')).toBe(true);
    expect(readFileSync(files[0], 'utf8')).toBe(ALIPAY_CSV);
  });

  it('解压到调用方指定的 outDir', () => {
    const zip = writeEncryptedZip('outdir.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    const outDir = tmpPath('outdir-target');
    const files = unzipBill(zip, ALIPAY_PASSWORD, outDir);

    expect(files.every((f) => f.startsWith(outDir))).toBe(true);
    expect(existsSync(outDir)).toBe(true);
  });

  it('支持压缩包内的子目录', () => {
    const zip = writeEncryptedZip('nested.zip', [{ name: '账单/alipay_record.csv', content: 'a,b\n' }], ALIPAY_PASSWORD);
    const files = unzipBill(zip, ALIPAY_PASSWORD);
    expect(files.some((f) => f.includes('alipay_record.csv'))).toBe(true);
  });

  it('多个条目全部解出', () => {
    const zip = writeEncryptedZip('multi.zip', [
      { name: 'alipaybill.csv', content: ALIPAY_CSV },
      { name: '说明.txt', content: '这是说明文件' },
    ], ALIPAY_PASSWORD);
    expect(unzipBill(zip, ALIPAY_PASSWORD)).toHaveLength(2);
  });

  it('错误密码抛 BillPasswordError（而不是静默产出空文件）', () => {
    const zip = writeEncryptedZip('wrongpw.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    expect(() => unzipBill(zip, '000000')).toThrow(BillPasswordError);
    expect(() => unzipBill(zip, '000000')).toThrow(/解压密码错误/);
  });

  // ISSUE-003 回归：ZipCrypto 密码校验只看 1 字节 verification byte，错误密码有
  // 约 1/256 概率蒙混过关，adm-zip 便放行、zlib 拿到乱码后抛 inflate 家族错误。
  // 这类"通过了校验的错误密码"过去全被归成 BillFormatError，通知文案会误导用户
  // 去查文件而不是去看最新密码。单个密码只有 ~0.35% 概率撞上，所以这里用 20 个
  // 各自蒙过校验的密码逐个钉死，任何一个漏成 BillFormatError 都算红。
  it('20 个不同错误密码全部抛 BillPasswordError（不误判成 BillFormatError）', () => {
    const zip = writeEncryptedZip('manywrongpw.zip', [{ name: 'a.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const entry = readFirstEncryptedEntry(zip);

    // 现挑 20 个恰好蒙过 verification byte 的错误密码。实测蒙混通过率约 1/290，
    // 所以扫 20000 次期望能挑出 ~69 个，挑不满就是"蒙混通过"的推导坏了——
    // 宁可当场红掉，也不要让本用例退化成只测普通错误密码的空转断言。
    const wrongPasswords: string[] = [];
    for (let i = 0; i < 20000 && wrongPasswords.length < 20; i++) {
      const pwd = `w${String(i).padStart(7, '0')}`;
      if (passesZipCryptoVerification(entry.payload, entry.header, pwd)) wrongPasswords.push(pwd);
    }
    expect(wrongPasswords.length).toBe(20);

    const used = new Set<string>();
    for (const pwd of wrongPasswords) {
      expect(used.has(pwd), `密码 ${pwd} 重复，本用例要求 20 个不同的错误密码`).toBe(false);
      used.add(pwd);

      let thrown: unknown;
      try {
        unzipBill(zip, pwd);
      } catch (e) {
        thrown = e;
      }
      const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
      expect(thrown, `错误密码 ${pwd} 竟然解压成功了`).toBeDefined();
      expect(thrown, `错误密码 ${pwd} 抛的是 ${detail}，应为 BillPasswordError（ISSUE-003）`)
        .toBeInstanceOf(BillPasswordError);
      expect(thrown, `错误密码 ${pwd} 被误判为 BillFormatError（ISSUE-003）：${detail}`)
        .not.toBeInstanceOf(BillFormatError);
    }
  });

  // 兜住上面新加的 CRC 分支的边界：只有"压缩包确实是加密的"且调用方给了密码时，
  // CRC 不符才算密码错误。未加密的包 CRC 对不上就是文件真损坏，必须照旧报格式错误，
  // 否则用户会被引导去反复重输一个本来就没错的密码。
  it('未加密的 ZIP 内容损坏时仍归 BillFormatError（不因给了密码就改判密码错误）', () => {
    const zip = new AdmZip();
    zip.addFile('bill.csv', Buffer.from('a,b\n1,2\n'));
    const buf = zip.toBuffer();
    // 只把本地文件头里的 CRC-32 改错：adm-zip 的校验读的是本地头那份
    // （置了 descriptor 标志位才读中央目录那份），数据仍能正常 inflate，
    // 拦下它的只剩 CRC 校验这一道，正好走到 unzipBill 的兜底分支。
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
    buf.writeUInt32LE((buf.readUInt32LE(14) ^ 0xffffffff) >>> 0, 14);
    const p = tmpPath('corrupt-plain.zip');
    writeFileSync(p, buf);

    expect(() => unzipBill(p, ALIPAY_PASSWORD)).toThrow(BillFormatError);
    expect(() => unzipBill(p, ALIPAY_PASSWORD)).toThrow(/CRC32 checksum failed/);
  });

  it('错误密码时不产生半拉解压结果', () => {
    const zip = writeEncryptedZip('nopartial.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    const outDir = tmpPath('nopartial-target');
    expect(() => unzipBill(zip, 'bad', outDir)).toThrow(BillPasswordError);
    // 目录建了但一个文件都没落盘：不会留下"看起来成功"的残缺产物
    expect(readdirSync(outDir)).toEqual([]);
  });

  it('错误密码时自建的临时目录会被清掉，不留垃圾', async () => {
    const countTemp = (): number =>
      readdirSync(tmpdir()).filter((n) => n.startsWith('hifin-bill-')).length;

    const zip = writeEncryptedZip('tmpcleanup.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    const before = countTemp();
    expect(() => unzipBill(zip, 'bad')).toThrow(BillPasswordError);
    // 并行测试文件也在同一 tmpdir 建/删 hifin-bill-* 目录，瞬时计数会 races
    // （历史 flake ~1/10：expected N+2 to be N）。给并行清理一个窗口再断言；
    // 若 2s 后仍多目录，那才是我们真的没清掉。
    await vi.waitFor(() => expect(countTemp()).toBe(before), { timeout: 2000, interval: 50 });
  });

  it('文件不存在抛 BillFormatError', () => {
    expect(() => unzipBill(tmpPath('nope.zip'), ALIPAY_PASSWORD)).toThrow(BillFormatError);
    expect(() => unzipBill(tmpPath('nope.zip'), ALIPAY_PASSWORD)).toThrow(/不存在/);
  });

  it('非 ZIP 文件抛 BillFormatError（提示要 .zip）', () => {
    const p = tmpPath('notzip.zip');
    writeFileSync(p, '这不是压缩包，只是一段文本');
    expect(() => unzipBill(p, ALIPAY_PASSWORD)).toThrow(BillFormatError);
    expect(() => unzipBill(p, ALIPAY_PASSWORD)).toThrow(/不是有效的 ZIP/);
  });

  it('目录路径抛 BillFormatError', () => {
    expect(() => unzipBill(TMP_ROOT, ALIPAY_PASSWORD)).toThrow(/不是文件/);
  });

  it('isZipFile 正确识别魔数', () => {
    const zip = writeEncryptedZip('magic.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    const plain = writePlainZip('magic-plain.zip', [{ name: 'a.csv', content: 'x\n' }]);
    const text = tmpPath('magic.txt');
    writeFileSync(text, 'hello');
    expect(isZipFile(zip)).toBe(true);
    expect(isZipFile(plain)).toBe(true);
    expect(isZipFile(text)).toBe(false);
  });

  it('cleanupBillDir 只删自带前缀的临时目录', () => {
    const auto = mkdtempSync(join(tmpdir(), 'hifin-bill-'));
    const own = tmpPath('user-owned');
    mkdirSync(own, { recursive: true });

    cleanupBillDir(auto);
    cleanupBillDir(own);
    expect(existsSync(auto)).toBe(false);
    expect(existsSync(own)).toBe(true);
  });
});

// ── findBillCsv ─────────────────────────────────────────────

describe('findBillCsv', () => {
  it('.csv 优先于 .txt', () => {
    const files = ['/x/说明.txt', '/x/账单.csv'];
    expect(findBillCsv(files)).toBe('/x/账单.csv');
  });

  it('没有 csv 时回退到 .txt', () => {
    expect(findBillCsv(['/x/说明.txt', '/x/备注.txt'])).toBe('/x/备注.txt');
  });

  it('跳过 __MACOSX / 隐藏文件 / .DS_Store', () => {
    const files = [
      '/x/__MACOSX/._账单.csv',
      '/x/.DS_Store.csv',
      '/x/真正的账单.csv',
    ];
    expect(findBillCsv(files)).toBe('/x/真正的账单.csv');
  });

  it('同类多文件时优先挑名字像账单的', () => {
    const files = ['/x/aaa.csv', '/x/关于账单导出说明.csv', '/x/alipay_record_2024.csv'];
    expect(findBillCsv(files)).toBe('/x/alipay_record_2024.csv');
  });

  it('同后缀时把"说明/关于"类文档排在账单正文之后', () => {
    const files = [
      '/x/关于账单导出说明.csv',
      '/x/常见问题.csv',
      '/x/交易明细.csv',
    ];
    expect(findBillCsv(files)).toBe('/x/交易明细.csv');
  });

  it('压缩包内 __MACOSX 子目录里的文件不会被选中', () => {
    const files = ['/x/__MACOSX/._alipaybill.csv', '/x/__MACOSX/alipaybill.csv', '/x/alipaybill.csv'];
    expect(findBillCsv(files)).toBe('/x/alipaybill.csv');
  });

  it('没有可用表格时返回 null', () => {
    expect(findBillCsv(['/x/logo.png', '/x/readme.md'])).toBeNull();
    expect(findBillCsv([])).toBeNull();
  });

  it('大写扩展名也能识别', () => {
    expect(findBillCsv(['/x/BILL.CSV'])).toBe('/x/BILL.CSV');
  });
});

// ── importBillZip ───────────────────────────────────────────

describe('importBillZip', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('导入支付宝账单：3 笔入账、2 笔跳过、余额联动正确', async () => {
    const zip = writeEncryptedZip('imp-alipay.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    const res = await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);

    expect(res.platform).toBe('alipay');
    expect(res.imported).toBe(3);
    expect(res.skipped).toBe(2); // 不计收支 1 行 + 金额非法 1 行
    expect(res.files).toHaveLength(1);

    const rows = db
      .prepare('SELECT name, type, amount, remark FROM transactions ORDER BY amount')
      .all() as Array<{ name: string; type: string; amount: number; remark: string | null }>;
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.name)).toEqual(['星巴克咖啡', '房租', '工资']);
    expect(rows[0].type).toBe('expense');
    expect(rows[2].type).toBe('income');
    expect(rows[0].remark).toBe('午餐');
  });

  it('余额按收入/支出正确增减', async () => {
    const zip = writeEncryptedZip('imp-balance.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);

    // 1000 - 35.5 - 1200 + 5000
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(4764.5);
  });

  it('落入的交易字段正确（类型/备注/账户）', async () => {
    const zip = writeEncryptedZip('imp-fields.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);

    const row = db
      .prepare('SELECT * FROM transactions WHERE name = ?')
      .get('星巴克咖啡') as { type: string; amount: number; remark: string; accountId: number; spaceId: number; date: number };
    expect(row.type).toBe('expense');
    expect(row.amount).toBeCloseTo(35.5);
    expect(row.remark).toBe('午餐');
    expect(row.accountId).toBe(1);
    expect(row.spaceId).toBe(1);
    // 2024-05-12 10:23 本地时间
    expect(new Date(row.date).getFullYear()).toBe(2024);
  });

  it('遵守 spaceId 参数', async () => {
    const zip = writeEncryptedZip('imp-space.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const res = await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1, 7);

    expect(res.imported).toBe(3);
    const row = db.prepare('SELECT spaceId FROM transactions LIMIT 1').get() as { spaceId: number };
    expect(row.spaceId).toBe(7);
  });

  it('应用 rules 表自动分类', async () => {
    db.prepare(
      `INSERT INTO categories (id, name, "group", type) VALUES (10, '餐饮', '餐饮', 'expense')`,
    ).run();
    const now = Date.now();
    db.prepare(
      `INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt)
       VALUES ('星巴克', 'merchant', 10, 100, 1, ?)`,
    ).run(now);

    const zip = writeEncryptedZip('imp-rules.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);

    const row = db.prepare('SELECT categoryId FROM transactions WHERE name = ?').get('星巴克咖啡') as {
      categoryId: number | null;
    };
    expect(row.categoryId).toBe(10);
  });

  it('同一份账单重复导入不会产生重复行（第二次全进 skipped）', async () => {
    const zip = writeEncryptedZip('imp-dup.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    const first = await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);
    expect(first.imported).toBe(3);

    const second = await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(5); // 2 行解析丢弃 + 3 行去重

    const count = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(3);
    // 余额没被二次扣减
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(4764.5);
  });

  it('微信账单（.txt 表格 + 测试密码）也能导入', async () => {
    const zip = writeEncryptedZip('imp-wechat.zip', [{ name: 'wechat_bill.txt', content: WECHAT_CSV }], WECHAT_PASSWORD);

    const res = await importBillZip(db, zip, 'wechat', WECHAT_PASSWORD, 1);
    expect(res.platform).toBe('wechat');
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(0);
    // 1000 - 88.8 - 25
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(886.2);
  });

  it('密码为空时报错（密码每次申请都不同，不允许省略）', async () => {
    const zip = writeEncryptedZip('imp-defaultpw.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'alipay', '', 1)).rejects.toThrow(/解压密码不能为空/);
  });

  it('未知平台且未给密码时报错', async () => {
    const zip = writeEncryptedZip('imp-nopw.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'cmb', '', 1)).rejects.toThrow(/解压密码/);
  });

  it('密码错误向上抛 BillPasswordError，且不落任何行', async () => {
    const zip = writeEncryptedZip('imp-badpw.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'alipay', '111111', 1)).rejects.toThrow(BillPasswordError);
    expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number }).balance).toBe(1000);
  });

  it('ZIP 里没有 csv/txt 时抛 BillCsvNotFoundError', async () => {
    const zip = writeEncryptedZip('no-csv.zip', [{ name: 'logo.png', content: 'PNG-BINARY' }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1)).rejects.toThrow(BillCsvNotFoundError);
  });

  it('账户不存在时抛错（沿用 importer 的 Account not found）', async () => {
    const zip = writeEncryptedZip('imp-noacct.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 999)).rejects.toThrow(/not found/);
  });

  it('accountId 非法时在解压前就报错', async () => {
    const zip = writeEncryptedZip('imp-badid.zip', [{ name: 'a.csv', content: 'x\n' }], ALIPAY_PASSWORD);
    await expect(importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 0)).rejects.toThrow(/accountId/);
  });

  it('解压后临时目录被清理干净', async () => {
    const zip = writeEncryptedZip('imp-cleanup.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const res = await importBillZip(db, zip, 'alipay', ALIPAY_PASSWORD, 1);
    expect(existsSync(dirname(res.files[0]))).toBe(false);
  });
});

// ── CLI import-bill ─────────────────────────────────────────

describe('CLI hifin import-bill', () => {
  it('跑通完整流程：建账户 → 解压导入 → 落库 + 余额联动', () => {
    const dbPath = tmpPath('cli.db');
    const zip = writeEncryptedZip('cli-alipay.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    // 1. 建账户
    runCli(['--db', dbPath, 'accounts', 'add', '--name', '支付宝', '--type', 'fund', '--balance', '1000']);

    // 2. 导入账单 ZIP
    const json = runCli([
      '--db', dbPath,
      'import-bill', zip,
      '--platform', 'alipay',
      '--password', ALIPAY_PASSWORD,
      '--accountId', '1',
    ]);

    const out = json as { platform: string; imported: number; skipped: number; files: string[] };
    expect(out.platform).toBe('alipay');
    expect(out.imported).toBe(3);
    expect(out.skipped).toBe(2);
    expect(out.files).toEqual(['alipaybill.csv']);

    // 3. 校验落库与余额
    const db = new Database(dbPath, { readonly: true });
    const count = (db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(3);
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(4764.5);
    db.close();
  }, 60000);

  it('显式 --password 生效（用错误密码时非零退出）', () => {
    const dbPath = tmpPath('cli-badpw.db');
    const zip = writeEncryptedZip('cli-badpw.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    runCli(['--db', dbPath, 'accounts', 'add', '--name', '支付宝', '--type', 'fund', '--balance', '1000']);

    const failed = runCliExpectFail([
      '--db', dbPath,
      'import-bill', zip,
      '--platform', 'alipay',
      '--password', '000000',
      '--accountId', '1',
    ]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toMatch(/解压密码错误/);

    // 失败后库里没有交易
    const db = new Database(dbPath, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(0);
    db.close();
  }, 60000);

  it('--space 透传到落库的交易', () => {
    const dbPath = tmpPath('cli-space.db');
    const zip = writeEncryptedZip('cli-space.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    runCli(['--db', dbPath, 'accounts', 'add', '--name', '支付宝', '--type', 'fund', '--balance', '1000', '--space', '3']);
    const json = runCli([
      '--db', dbPath,
      'import-bill', zip,
      '--platform', 'alipay',
      '--password', ALIPAY_PASSWORD,
      '--accountId', '1',
      '--space', '3',
    ]);
    expect((json as { imported: number }).imported).toBe(3);

    const db = new Database(dbPath, { readonly: true });
    const row = db.prepare('SELECT spaceId FROM transactions LIMIT 1').get() as { spaceId: number };
    expect(row.spaceId).toBe(3);
    db.close();
  }, 60000);

  it('账户不存在时报错并以非零码退出', () => {
    const dbPath = tmpPath('cli-noacct.db');
    const zip = writeEncryptedZip('cli-noacct.zip', [{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);

    const failed = runCliExpectFail([
      '--db', dbPath,
      'import-bill', zip,
      '--platform', 'alipay',
      '--password', ALIPAY_PASSWORD,
      '--accountId', '42',
    ]);
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toMatch(/账户 42 不存在/);
  }, 60000);
});

// ── 邮件附件识别（poller 新增的纯函数） ─────────────────────

describe('账单附件识别', () => {
  it('detectBillPlatform 从发件人/主题认平台', () => {
    expect(detectBillPlatform('支付宝 <notice@alipay.com>', '账单')).toBe('alipay');
    expect(detectBillPlatform('x@y.com', '微信支付账单')).toBe('wechat');
    expect(detectBillPlatform('x@y.com', 'WeChat Pay')).toBe('wechat');
    expect(detectBillPlatform('someone@qq.com', '周末吃饭？')).toBeNull();
  });

  it('在 multipart 结构里找到 application/zip 部件', () => {
    const bs = {
      type: 'multipart/mixed',
      part: '1',
      childNodes: [
        { type: 'text/plain', part: '1.1', size: 100 },
        {
          type: 'application/zip',
          part: '1.2',
          disposition: 'attachment',
          dispositionParameters: { filename: 'alipaybill.zip' },
        },
      ],
    };
    const found = findBillAttachments(bs);
    expect(found).toHaveLength(1);
    expect(found[0].part).toBe('1.2');
    expect(found[0].filename).toBe('alipaybill.zip');
  });

  it('application/octet-stream 也算附件', () => {
    const found = findBillAttachments({
      type: 'multipart/alternative',
      part: '1',
      childNodes: [{ type: 'application/octet-stream', part: '2', dispositionParameters: { filename: '账单' } }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].part).toBe('2');
  });

  it('zip 类型的附件排在 octet-stream 之前', () => {
    const found = findBillAttachments({
      type: 'multipart/mixed',
      part: '1',
      childNodes: [
        { type: 'application/octet-stream', part: '1.1', dispositionParameters: { filename: 'logo.bin' } },
        { type: 'application/zip', part: '1.2', dispositionParameters: { filename: 'bill.zip' } },
      ],
    });
    expect(found[0].part).toBe('1.2');
  });

  it('multipart 容器节点本身不算附件', () => {
    expect(
      findBillAttachments({ type: 'multipart/mixed', part: '1', childNodes: [{ type: 'text/html', part: '1.1' }] }),
    ).toHaveLength(0);
  });

  it('纯文本邮件 / 未解析的字符串 / 空值都返回空数组', () => {
    expect(findBillAttachments({ type: 'text/plain', part: '1' })).toHaveLength(0);
    expect(findBillAttachments('BODYSTRUCTURE 解析失败')).toHaveLength(0);
    expect(findBillAttachments(undefined)).toHaveLength(0);
    expect(findBillAttachments(null)).toHaveLength(0);
  });

  it('提示文案是约定的中文原文', () => {
    expect(NO_ATTACHMENT_HINT).toBe('发现账单邮件但无附件，请手动下载后用 import-bill 导入');
  });
});

// ── poller：通知型账单邮件的附件自动导入 ─────────────────────

interface FakeMsg {
  from: { name: string; address: string };
  subject: string;
  source: string;
  bodyStructure?: unknown;
}

/**
 * 装一个假 IMAP client。刻意同时提供 fetch（迭代器）和 fetchOne，
 * 以便断言 poller 走的是迭代器那条路。
 */
function attachBillClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  poller: any,
  messages: FakeMsg[],
  attachment: Buffer | null,
): { flagged: number[]; fetched: number[]; fetchOneCalls: number[] } {
  const flagged: number[] = [];
  const fetched: number[] = [];
  const fetchOneCalls: number[] = [];
  const client = {
    getMailboxLock: async () => ({ release: () => undefined }),
    search: async () => messages.map((_, i) => i + 1),
    // eslint-disable-next-line @typescript-eslint/require-await
    async *fetch(uid: string) {
      fetched.push(Number(uid));
      const m = messages[Number(uid) - 1];
      if (m) {
        yield { envelope: { from: [m.from], subject: m.subject }, source: Buffer.from(m.source), bodyStructure: m.bodyStructure };
      }
    },
    async fetchOne(uid: string) {
      fetchOneCalls.push(Number(uid));
      return false; // 模拟 QQ 邮箱 fetchOne 返回空的老毛病
    },
    async download() {
      if (!attachment) return { content: undefined };
      return { meta: { filename: 'alipaybill.zip' }, content: Readable.from([attachment]) };
    },
    async messageFlagsAdd(uid: string) {
      flagged.push(Number(uid));
    },
  };
  poller.client = client;
  return { flagged, fetched, fetchOneCalls };
}

/** 支付宝"通知型"邮件的 bodyStructure：正文 + 一个 zip 附件 */
function zipBodyStructure(): unknown {
  return {
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
}

const POLLER_CONFIG = {
  host: 'imap.qq.com',
  port: 993,
  user: 'me@qq.com',
  password: 'imap-auth-code',
};

describe('MailPoller 通知型账单邮件（附件自动导入）', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('检测到 zip 附件 → 下载 → 自动入库 → 标记已读', async () => {
    const zip = buildEncryptedZip([{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const outcomes: Array<{ status: string; imported?: number }> = [];

    const poller = new MailPoller(POLLER_CONFIG, {
      db,
      accountId: 1,
      spaceId: 1,
      billPasswords: { alipay: ALIPAY_PASSWORD },
      onBill: (o) => outcomes.push({ status: o.status, imported: o.imported }),
    });
    const { flagged, fetched, fetchOneCalls } = attachBillClient(
      poller,
      [
        {
          from: { name: '支付宝', address: 'notice@alipay.com' },
          subject: '你的账单文件已生成',
          source: '账单文件已生成，请下载查阅。',
          bodyStructure: zipBodyStructure(),
        },
      ],
      zip,
    );

    const txs = await poller.poll(7);
    expect(txs).toEqual([]); // 正文里没有流水，解析器抽不出东西
    expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(3);

    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(4764.5);

    expect(outcomes).toEqual([{ status: 'imported', imported: 3 }]);
    expect(flagged).toEqual([1]); // 导入成功才标记已读
    // 关键：走 fetch 迭代器，绕开 fetchOne 返回空的坑
    expect(fetched).toEqual([1]);
    expect(fetchOneCalls).toEqual([]);

    const stats = poller.getStats();
    expect(stats).toMatchObject({ fetched: 1, parsed: 0, skipped: 0, errors: [] });
  });

  it('没有附件（只有下载链接）→ 标记已读并给出 import-bill 提示', async () => {
    const outcomes: Array<{ status: string; hint?: string }> = [];

    const poller = new MailPoller(POLLER_CONFIG, {
      db,
      accountId: 1,
      onBill: (o) => outcomes.push({ status: o.status, hint: o.hint }),
    });
    const { flagged } = attachBillClient(
      poller,
      [
        {
          from: { name: '支付宝', address: 'notice@alipay.com' },
          subject: '你的账单已生成',
          source: '请前往支付宝-我的-账单下载。',
          bodyStructure: { type: 'text/plain', part: '1' },
        },
      ],
      null,
    );

    await poller.poll(7);

    expect(outcomes).toEqual([{ status: 'no-attachment', hint: NO_ATTACHMENT_HINT }]);
    expect(flagged).toEqual([1]); // 提示过就不必每轮重复提示
    expect(poller.getStats()).toMatchObject({ fetched: 1, skipped: 1, errors: [] });
    expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(0);
  });

  it('附件密码不对 → 记为 error、不标记已读，下轮还能重试', async () => {
    const zip = buildEncryptedZip([{ name: 'alipaybill.csv', content: ALIPAY_CSV }], ALIPAY_PASSWORD);
    const outcomes: Array<{ status: string; message?: string }> = [];

    const poller = new MailPoller(POLLER_CONFIG, {
      db,
      accountId: 1,
      // 故意给错密码
      billPasswords: { alipay: '000000' },
      onBill: (o) => outcomes.push({ status: o.status, message: o.message }),
    });
    const { flagged } = attachBillClient(
      poller,
      [
        {
          from: { name: '支付宝', address: 'notice@alipay.com' },
          subject: '你的账单文件已生成',
          source: '账单文件已生成',
          bodyStructure: zipBodyStructure(),
        },
      ],
      zip,
    );

    await poller.poll(7);

    expect(outcomes[0].status).toBe('error');
    expect(outcomes[0].message).toMatch(/解压密码错误/);
    expect(flagged).toEqual([]); // 失败不标记已读
    expect((db.prepare('SELECT COUNT(*) AS c FROM transactions').get() as { c: number }).c).toBe(0);
    expect(poller.getStats().errors).toHaveLength(1);
  });

  it('未提供 db 时不自动导入，只提示（避免误写库）', async () => {
    const outcomes: Array<{ status: string }> = [];
    const poller = new MailPoller(POLLER_CONFIG, { onBill: (o) => outcomes.push({ status: o.status }) });
    attachBillClient(
      poller,
      [
        {
          from: { name: '微信支付', address: 'wx@tencent.com' },
          subject: '微信支付账单',
          source: '请下载账单文件',
          bodyStructure: zipBodyStructure(),
        },
      ],
      null,
    );

    await poller.poll(7);
    expect(outcomes).toEqual([{ status: 'no-attachment' }]);
  });

  it('非账单邮件不受影响：照旧计入 skipped', async () => {
    const poller = new MailPoller(POLLER_CONFIG, { db, accountId: 1 });
    const { flagged } = attachBillClient(
      poller,
      [
        {
          from: { name: '张三', address: 'zhangsan@qq.com' },
          subject: '周末一起吃饭？',
          source: '随便聊聊',
          bodyStructure: { type: 'text/plain', part: '1' },
        },
      ],
      null,
    );

    await poller.poll(7);
    expect(poller.getStats()).toMatchObject({ fetched: 1, skipped: 1, errors: [] });
    expect(flagged).toEqual([]);
    expect(poller.getBillOutcomes()).toEqual([]);
  });
});
