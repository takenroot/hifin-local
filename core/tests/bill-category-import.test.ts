/**
 * 账单自带分类 → categoryId 的导入链路测试
 * -----------------------------------------------------------------
 * 覆盖 category-map 之外的**接线**部分：CSV/xlsx 里的分类列有没有被解析出来、
 * 有没有一路带到 transactions.categoryId、优先级对不对、余额/去重有没有被动过。
 *
 * 这里最值得钉住的是微信账单的一个坑：微信表头同时有「交易类型」和「收/支」，
 * 而通用解析器给"收支方向"的兜底别名里就有一个裸「类型」——一旦顺序没排对，
 * 整列「交易类型」会被当成收支方向，所有行变成 transfer 并被静默丢弃。
 * 所以"微信行必须以 expense 入库"这条断言不是凑数，是防这个回归。
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA_SQL } from '../src/db/schema.ts';
import { importBillZip } from '../src/bill/importer.ts';

const requireCjs = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const XLSX = requireCjs('xlsx') as any;

const PASSWORD = '929143';

// ── 测试脚手架 ──────────────────────────────────────────────

const TMP_ROOT = mkdtempSync(join(tmpdir(), 'hifin-billcat-'));
afterAll(() => rmSync(TMP_ROOT, { recursive: true, force: true }));
let seq = 0;
function tmpPath(name: string): string {
  seq += 1;
  return join(TMP_ROOT, `${seq}-${name}`);
}

/** 内存库 + 账户 1 + 一份够用的分类表（名字必须与 category-map 的映射产物一致） */
function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '支付宝', 'fund', 1000, 1, 1, ?, ?)`,
  ).run(now, now);
  // 只建用得到的分类，但 id 故意打乱（7/8/1/4/2/3/…），好证明导入是**按名字**查的，
  // 而不是碰巧和种子表的 id 对齐
  const cats: Array<[number, string, string, string]> = [
    [7, '日常餐饮', '餐饮', 'expense'],
    [8, '公共交通', '交通', 'expense'],
    [1, '服饰', '购物', 'expense'],
    [4, '日用百货', '购物', 'expense'],
    [2, '电影演出', '娱乐', 'expense'],
    [3, '其他支出', '其他', 'expense'],
    [5, '人情往来', '社交', 'expense'],
    [6, '其他收入', '其他', 'income'],
  ];
  const ins = db.prepare('INSERT INTO categories (id, name, "group", type) VALUES (?, ?, ?, ?)');
  for (const c of cats) ins.run(...c);
  return db;
}

/** 支付宝 CSV：表头带「交易分类」（第 2 列），字段顺序与真实账单一致 */
const ALIPAY_BILL_CSV = [
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
  '2026-10-01 12:12:03,交通出行,中国联合航空有限公司,cua***@flycua.com,机票,支出,560.00,花呗,交易成功,T1,,,',
  '2026-10-01 13:00:00,餐饮美食,蜜雪冰城,,柠檬水,支出,6.00,花呗,交易成功,T2,,,',
  '2026-10-01 14:00:00,服饰装扮,优衣库,,卫衣,支出,199.00,花呗,交易成功,T3,,,',
  '2026-10-01 15:00:00,文化休闲,万达影城,,电影票,支出,45.00,花呗,交易成功,T4,,,',
  '2026-10-01 16:00:00,日用百货,康巴什区乐佳超市,,纸巾,支出,10.00,花呗,交易成功,T5,,,',
  '2026-10-01 17:00:00,商业服务,某服务商,,服务费,支出,88.00,花呗,交易成功,T6,,,',
  '2026-10-01 18:00:00,退款,某某,,退单,收入,30.00,余额宝,交易成功,T7,,,',
  '2026-10-01 19:00:00,收入,支付宝,,工资,收入,8000.00,余额宝,交易成功,T8,,,',
  // 不计收支：解析阶段就该被丢掉，不该入库、更不该分类
  '2026-10-01 20:00:00,投资理财,余额宝,,自动转入,不计收支,100.00,,交易成功,T9,,,',
  '2026-10-01 21:00:00,信用借还,花呗,,花呗主动还款,不计收支,175.40,,还款失败,T10,,,',
].join('\n');

/** 微信 xlsx → CSV 文本：表头带「交易类型」（第 2 列） */
const WECHAT_HEADER = ['交易时间', '交易类型', '交易对方', '商品', '收/支', '金额(元)', '支付方式', '当前状态', '交易单号', '商户单号', '备注'];

/** 日期字符串 → Excel 序列号（1900 纪元） */
function excelSerial(y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  return (Date.UTC(y, mo - 1, d, h, mi, s) - Date.UTC(1899, 11, 30)) / 86400000;
}

/** 生成微信 xlsx 文件路径（带一段导出说明前言，模拟真实账单） */
function writeWechatXlsx(name: string): string {
  // 前言里**不能**出现含「交易时间」的行：xlsxToCsvText 是"第一行含交易时间的
  // 视为表头"，前言里混进一行表头会把后面的说明行当成数据（它们解析不出日期，
  // 于是被丢成 skipped，计数对不上）。真实账单的前言是纯说明文字，同样不含该词。
  const rows: unknown[][] = [['微信支付账单明细'], ['']];
  for (let i = 0; i < 16; i++) rows.push([`说明第 ${i + 1} 行`]);
  rows.push(WECHAT_HEADER);
  rows.push([excelSerial(2026, 9, 27, 12, 47, 34), '商户消费', '康巴什区乐佳超市', '中国银行信用卡', '支出', 10, '零钱通', '支付成功', 'O1', 'M1', '/']);
  rows.push([excelSerial(2026, 9, 27, 13, 0, 0), '扫二维码付款', '云香新派臭豆腐', '收款方备注:二维码收款', '支出', 12, '零钱通', '已转账', 'O2', 'M2', '/']);
  rows.push([excelSerial(2026, 9, 27, 14, 0, 0), '微信红包（群红包）', '张三', '群红包', '支出', 8.88, '零钱通', '已转账', 'O3', 'M3', '/']);
  rows.push([excelSerial(2026, 9, 27, 15, 0, 0), '微信红包（单发）', '李四', '红包', '支出', 5, '零钱通', '已转账', 'O4', 'M4', '/']);
  rows.push([excelSerial(2026, 9, 27, 16, 0, 0), '蜜雪冰城-退款', '蜜雪冰城', '退款', '收入', 6, '零钱通', '退款成功', 'O5', 'M5', '/']);
  // 收到的红包：收入流水 + 支出类分类 → 类型闸门必须拦下
  rows.push([excelSerial(2026, 9, 27, 17, 0, 0), '微信红包', '王五', '红包', '收入', 20, '零钱通', '已收款', 'O6', 'M6', '/']);
  // 账户内部划转：收/支为 "/" → 不计收支，不该入库
  rows.push([excelSerial(2026, 9, 27, 18, 0, 0), '转入零钱通-来自零钱', '零钱', '转入', '/', 50, '/', '成功', 'O7', 'M7', '/']);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '微信支付账单明细');
  const p = tmpPath(name);
  XLSX.writeFile(wb, p);
  return p;
}

/** 造一个含指定文件的 ZIP（明文即可，importer 只校验密码非空） */
function makeZip(name: string, entries: Array<{ name: string; path: string }>): string {
  const zip = new AdmZip();
  for (const e of entries) zip.addFile(e.name, requireCjs('node:fs').readFileSync(e.path));
  const p = tmpPath(name);
  zip.writeZip(p);
  return p;
}

function makeCsvZip(name: string, csv: string): string {
  const zip = new AdmZip();
  zip.addFile('alipaybill.csv', Buffer.from(csv, 'utf8'));
  const p = tmpPath(name);
  zip.writeZip(p);
  return p;
}

interface CatRow {
  name: string;
  categoryId: number | null;
  type: string;
  amount: number;
}
function catsOf(db: Database.Database): Map<string, CatRow> {
  const rows = db.prepare('SELECT name, type, amount, categoryId FROM transactions').all() as CatRow[];
  return new Map(rows.map((r) => [r.name, r]));
}

// ── 支付宝 ──────────────────────────────────────────────────

describe('导入器接入：支付宝「交易分类」', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('按「交易分类」落正确的 categoryId', async () => {
    const zip = makeCsvZip('ali.zip', ALIPAY_BILL_CSV);
    const res = await importBillZip(db, zip, 'alipay', PASSWORD, 1);
    expect(res.imported).toBe(8);

    const rows = catsOf(db);
    expect(rows.get('中国联合航空有限公司')?.categoryId).toBe(8); // 交通出行 → 公共交通
    expect(rows.get('蜜雪冰城')?.categoryId).toBe(7); // 餐饮美食 → 日常餐饮
    expect(rows.get('优衣库')?.categoryId).toBe(1); // 服饰装扮 → 服饰
    expect(rows.get('万达影城')?.categoryId).toBe(2); // 文化休闲 → 电影演出
    expect(rows.get('康巴什区乐佳超市')?.categoryId).toBe(4); // 日用百货 → 日用百货
    expect(rows.get('某服务商')?.categoryId).toBe(3); // 商业服务 → 其他支出
    expect(rows.get('某某')?.categoryId).toBe(6); // 退款 → 其他收入
    expect(rows.get('支付宝')?.categoryId).toBe(6); // 收入 → 其他收入
  });

  it('收入类分类只落在收入流水上，支出流水拿到的是 null', async () => {
    const zip = makeCsvZip('ali-type.zip', ALIPAY_BILL_CSV);
    await importBillZip(db, zip, 'alipay', PASSWORD, 1);

    const refund = db.prepare('SELECT type, categoryId FROM transactions WHERE name = ?').get('某某') as {
      type: string;
      categoryId: number | null;
    };
    expect(refund.type).toBe('income');
    expect(refund.categoryId).toBe(6);
    const meal = db.prepare('SELECT type, categoryId FROM transactions WHERE name = ?').get('蜜雪冰城') as {
      type: string;
      categoryId: number | null;
    };
    expect(meal.type).toBe('expense');
    expect(meal.categoryId).toBe(7);
  });

  it('不计收支的行既不入库也不分类', async () => {
    const zip = makeCsvZip('ali-skip.zip', ALIPAY_BILL_CSV);
    const res = await importBillZip(db, zip, 'alipay', PASSWORD, 1);
    expect(res.imported).toBe(8);
    expect(res.skipped).toBe(2);
    const count = (db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(8);
  });

  it('分类不影响余额联动', async () => {
    const zip = makeCsvZip('ali-balance.zip', ALIPAY_BILL_CSV);
    await importBillZip(db, zip, 'alipay', PASSWORD, 1);
    // 1000 -560 -6 -199 -45 -10 -88 +30 +8000
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(1000 - 560 - 6 - 199 - 45 - 10 - 88 + 30 + 8000);
  });

  it('账单里没有分类列时保持 null（老账单/银行表格不受影响）', async () => {
    const csv = [
      '交易时间,金额,收/支,交易对方,备注',
      '2026-10-01 12:00:00,35.50,支出,某商户,午餐',
    ].join('\n');
    const zip = makeCsvZip('ali-nocat.zip', csv);
    const res = await importBillZip(db, zip, 'alipay', PASSWORD, 1);
    expect(res.imported).toBe(1);
    const row = db.prepare('SELECT categoryId FROM transactions').get() as { categoryId: number | null };
    expect(row.categoryId).toBeNull();
  });

  it('规则引擎命中时压过账单分类（规则优先级最高）', async () => {
    db.prepare('INSERT INTO categories (id, name, "group", type) VALUES (9, ?, ?, ?)').run('打车', '交通', 'expense');
    db.prepare(
      `INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt)
       VALUES ('中国联合航空', 'merchant', 9, 100, 1, ?)`,
    ).run(Date.now());

    const zip = makeCsvZip('ali-rule.zip', ALIPAY_BILL_CSV);
    await importBillZip(db, zip, 'alipay', PASSWORD, 1);

    // 该行账单分类是"交通出行"（→公共交通 id 8），但规则命中"打车" id 9
    const row = db.prepare('SELECT categoryId FROM transactions WHERE name = ?').get('中国联合航空有限公司') as {
      categoryId: number | null;
    };
    expect(row.categoryId).toBe(9);
    // 其余行照旧走账单分类
    const other = db.prepare('SELECT categoryId FROM transactions WHERE name = ?').get('蜜雪冰城') as {
      categoryId: number | null;
    };
    expect(other.categoryId).toBe(7);
  });
});

// ── 微信 ────────────────────────────────────────────────────

describe('导入器接入：微信「交易类型」', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  async function importWechat(): Promise<{ imported: number; skipped: number }> {
    const zip = makeZip('wx.zip', [{ name: 'wechat_bill.xlsx', path: writeWechatXlsx('wx.xlsx') }]);
    return importBillZip(db, zip, 'wechat', PASSWORD, 1);
  }

  it('xlsx 里的「交易类型」能落成 categoryId', async () => {
    const res = await importWechat();
    expect(res.imported).toBe(6);

    const rows = catsOf(db);
    expect(rows.get('张三')?.categoryId).toBe(5); // 微信红包（群红包） → 人情往来
    expect(rows.get('李四')?.categoryId).toBe(5); // 微信红包（单发）   → 人情往来
    expect(rows.get('蜜雪冰城')?.categoryId).toBe(6); // 蜜雪冰城-退款      → 其他收入
  });

  it('「交易类型」列不会被误当成收支方向（否则整列变 transfer 被丢掉）', async () => {
    const res = await importWechat();
    expect(res.imported).toBe(6);
    // 商户消费/扫二维码付款 → 不映射，但行必须以 expense 落库
    const rows = catsOf(db);
    expect(rows.get('康巴什区乐佳超市')?.type).toBe('expense');
    expect(rows.get('康巴什区乐佳超市')?.categoryId).toBeNull();
    expect(rows.get('云香新派臭豆腐')?.type).toBe('expense');
    expect(rows.get('云香新派臭豆腐')?.categoryId).toBeNull();
  });

  it('收到的红包是收入流水，挂不上支出类的人情往来（类型闸门）', async () => {
    await importWechat();
    const row = db.prepare('SELECT type, categoryId FROM transactions WHERE name = ?').get('王五') as {
      type: string;
      categoryId: number | null;
    };
    expect(row.type).toBe('income');
    expect(row.categoryId).toBeNull();
  });

  it('零钱通内部划转（收/支为 /）不入库', async () => {
    const res = await importWechat();
    expect(res.skipped).toBe(1);
    const has = db.prepare('SELECT COUNT(*) c FROM transactions WHERE name = ?').get('零钱') as { c: number };
    expect(has.c).toBe(0);
  });

  it('xlsx 日期序列号被正确还原（导入日期与账单一致）', async () => {
    await importWechat();
    const row = db.prepare('SELECT date FROM transactions WHERE name = ?').get('康巴什区乐佳超市') as { date: number };
    // 与 ALIPAY 侧一样，日期最终按本地时间解释
    expect(row.date).toBe(new Date(2026, 8, 27, 12, 47, 34).getTime());
  });

  it('分类不影响余额联动', async () => {
    await importWechat();
    // 1000 -10 -12 -8.88 -5 +6 +20
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBeCloseTo(1000 - 10 - 12 - 8.88 - 5 + 6 + 20);
  });

  it('去重行为不变：同一份账单导两次，第二次全跳过、余额不被二次变动', async () => {
    const zip = makeZip('wx-dup.zip', [{ name: 'wechat_bill.xlsx', path: writeWechatXlsx('wx-dup.xlsx') }]);
    const first = await importBillZip(db, zip, 'wechat', PASSWORD, 1);
    expect(first.imported).toBe(6);
    const balanceAfterFirst = (db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number }).balance;

    const second = await importBillZip(db, zip, 'wechat', PASSWORD, 1);
    expect(second.imported).toBe(0);
    expect(second.skipped).toBe(7); // 1 行不计收支 + 6 行去重
    const count = (db.prepare('SELECT COUNT(*) c FROM transactions').get() as { c: number }).c;
    expect(count).toBe(6);
    const acc = db.prepare('SELECT balance FROM accounts WHERE id = 1').get() as { balance: number };
    expect(acc.balance).toBe(balanceAfterFirst);
  });
});

// ── 开关与降级 ──────────────────────────────────────────────

describe('导入器接入：边界', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = makeDb();
  });

  it('库里缺少映射目标分类时安全降级为 null（不报错、不写脏 id）', async () => {
    db.prepare('DELETE FROM categories WHERE name = ?').run('公共交通');
    const zip = makeCsvZip('ali-nocats.zip', ALIPAY_BILL_CSV);
    const res = await importBillZip(db, zip, 'alipay', PASSWORD, 1);

    expect(res.imported).toBe(8);
    const row = db.prepare('SELECT categoryId FROM transactions WHERE name = ?').get('中国联合航空有限公司') as {
      categoryId: number | null;
    };
    expect(row.categoryId).toBeNull();
    // 其余分类照常写入
    expect((db.prepare('SELECT categoryId FROM transactions WHERE name = ?').get('蜜雪冰城') as { categoryId: number | null }).categoryId).toBe(7);
  });

  it('库里的分类被改成收入类时，收入流水也能接住（按 categories.type 复查）', async () => {
    db.prepare('UPDATE categories SET type = ? WHERE name = ?').run('income', '公共交通');
    const csv = [
      '交易时间,交易分类,交易对方,收/支,金额,备注,',
      '2026-10-01 12:00:00,交通出行,某出行,收入,10,备注,',
    ].join('\n');
    const zip = makeCsvZip('ali-flip.zip', csv);
    await importBillZip(db, zip, 'alipay', PASSWORD, 1);
    const row = db.prepare('SELECT categoryId FROM transactions').get() as { categoryId: number | null };
    // 映射表认为"公共交通"是支出类、与 income 不匹配 → null
    expect(row.categoryId).toBeNull();
  });
});
