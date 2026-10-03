/**
 * 多账户分流 + 账户间划转 测试
 * -----------------------------------------------------------------
 * 覆盖三段链路：
 *   1. importBillZip 端到端：用**实测账单片段**（微信/支付宝真实表头与行）
 *      造 ZIP 走完整条链路，验证划转/还款行不再被丢弃、双边方向正确
 *   2. importTransactions(accountMap)：普通收支按 paymentMethod 落账户、
 *      划转按两端账户名落 accountId/toAccountId 并联动双边余额
 *   3. 向后兼容：**不传 accountMap 时行为与改造前逐项一致**
 *
 * 账单片段的字段名/取值全部照抄 /tmp/check-alipay.zip 与
 * /tmp/check-wechat.xlsx（20251201-20261002），不是编的——尤其是
 * 微信划转行「收/支」列写的是 `/`（所以解析层判为 excluded）、支付宝
 * 还款行「收/支」列写的是 `不计收支`，正是本次要救回来的那两类。
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import AdmZip from 'adm-zip';
import { join } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { importBillZip } from '../src/bill/importer.ts';
import { importTransactions, type AccountMap } from '../src/mail/importer.ts';
import type { ParsedTx } from '../src/mail/parsers/base.ts';
import { ACCOUNT_NAMES } from '../src/bill/account-map.ts';

const PWD = 'test-pwd';
let workDir = '';

/** 造一个**不加密**的 ZIP：unzipBill 传密码对未加密包照样能解 */
function writePlainZip(name: string, fileName: string, content: string): string {
  const zip = new AdmZip();
  zip.addFile(fileName, Buffer.from(content, 'utf8'));
  const p = join(workDir, name);
  zip.writeZip(p);
  return p;
}

/** 建 7 个账户（id 1..7），返回 name→id 的分流表 */
function makeDb(): { db: Database.Database; map: AccountMap } {
  const db = openDatabase(':memory:');
  migrate(db);
  const now = Date.now();
  const rows: Array<[number, string, string]> = [
    [1, ACCOUNT_NAMES.wechatInvest, 'invest'],
    [2, ACCOUNT_NAMES.alipayInvest, 'invest'],
    [3, ACCOUNT_NAMES.icbc, 'fund'],
    [4, ACCOUNT_NAMES.boc, 'fund'],
    [5, ACCOUNT_NAMES.ccb, 'fund'],
    [6, ACCOUNT_NAMES.huabei, 'credit'],
    [7, ACCOUNT_NAMES.fallback, 'fund'],
  ];
  const ins = db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (?, ?, ?, 0, 1, 1, ?, ?)`,
  );
  for (const [id, name, type] of rows) ins.run(id, name, type, now, now);
  const map: Record<string, number> = {};
  for (const [id, name] of rows) map[name] = id;
  return { db, map };
}

function balanceOf(db: Database.Database, id: number): number {
  const r = db.prepare('SELECT balance FROM accounts WHERE id = ?').get(id) as
    | { balance: number }
    | undefined;
  return r?.balance ?? NaN;
}

function rowsOf(db: Database.Database): Array<{
  type: string;
  name: string;
  amount: number;
  accountId: number;
  toAccountId: number | null;
  paymentMethod: string | null;
  source: string | null;
  externalId: string | null;
  status: string | null;
}> {
  return db
    .prepare('SELECT type, name, amount, accountId, toAccountId, paymentMethod, source, externalId, status FROM transactions ORDER BY id')
    .all() as never;
}

beforeEach(() => {
  if (!workDir) workDir = mkdtempSync(join(tmpdir(), 'hifin-tx-'));
});
afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
/** 微信账单片段：表头与行全部照抄实测 xlsx 转出的 CSV */
const WECHAT_CSV = [
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注',
  // ① 银行卡转入零钱通（实测 11 笔）→ 划转：工行卡 → 零钱通
  '2026-09-05 11:20:00,转入零钱通-来自工商银行(1230),/,/,/,1000,工商银行储蓄卡(1230),支付成功,4200003148202609057500001,WPX1,/',
  // ② "来自零钱"归并后是自转（实测 13 笔）→ 必须跳过
  '2026-08-10 09:00:00,转入零钱通-来自零钱,/,/,/,40.67,零钱,支付成功,4500000324202608107500002,WPX2,/',
  // ③ 零钱通转出到银行卡（实测 1 笔）→ 划转：零钱通 → 工行卡
  '2026-09-01 08:00:00,零钱通转出-到工商银行(1230),/,/,/,5000,零钱通,资金已到账,1800007774260901000000003,WPX3,/',
  // ④ 建行/中行转入（实测各 1 笔）
  '2026-07-26 10:00:00,转入零钱通-来自建设银行(9151),/,/,/,3000,建设银行储蓄卡(9151),支付成功,4500000268202607265700004,WPX4,/',
  '2026-07-20 10:00:00,转入零钱通-来自中国银行(3544),/,/,/,800,中国银行储蓄卡(3544),支付成功,4500000268202607265700005,WPX5,/',
  // ⑤ 普通消费，走支付方式分流
  '2026-09-27 15:00:00,商户消费,康巴什区乐佳超市,中国银行信用卡,支出,10,零钱通,支付成功,4500000472202609272900006,WPX6,/',
  '2026-09-20 12:00:00,商户消费,蜜雪冰城,蜜雪冰城店,支出,6,零钱,支付成功,4500000442202609264900007,WPX7,/',
  '2026-09-15 09:00:00,商户消费,某商户,/,支出,25.5,工商银行储蓄卡(1230)&优惠,支付成功,4500000442202609264900008,WPX8,/',
  '2026-09-14 09:00:00,商户消费,某商户2,/,支出,88,/,支付成功,4500000442202609264900009,WPX9,/',
  // ⑥ 转出失败（不联动、不生成）
  '2026-09-13 09:00:00,转入零钱通-来自工商银行(1230),/,/,/,700,工商银行储蓄卡(1230),转出失败,4200003148202609264900010,WPX10,/',
  '',
].join('\n');

/** 支付宝账单片段：表头与行全部照抄实测 CSV（GBK 解码后） */
const ALIPAY_CSV = [
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,',
  // ① 还款成功（实测 10 笔）→ 划转：付款账户 → 花呗
  '2026-09-01 16:36:31,信用借还,花呗,/,花呗主动还款-2026年09月账单,不计收支,2450.40,工商银行储蓄卡(1230),还款成功,2026090129020999060000001\t,\t,,',
  '2026-05-03 10:17:59,信用借还,花呗,/,花呗主动还款-2026年05月账单,不计收支,211.76,余额宝,还款成功,2026050329020999060000002\t,\t,,',
  '2026-02-07 11:23:35,信用借还,花呗,/,花呗主动还款-2026年02月账单,不计收支,547.19,内蒙古农信储蓄卡(6322),还款成功,2026020729020999060000003\t,\t,,',
  // ② 其它状态：必须继续丢弃
  '2026-10-01 18:30:32,信用借还,花呗,/,花呗主动还款,不计收支,175.40,,还款失败,2026100129020999060000004\t,\t,,',
  '2026-07-17 09:57:38,信用借还,,,无人机/电池租赁,不计收支,0.00,,芝麻免押下单成功,2026071709596988060000005\t,\t,,',
  '2026-07-17 09:57:37,信用借还,,,押金解冻,不计收支,0.00,,解冻成功,2026071709510029060000006\t,\t,,',
  // ③ 普通消费，按收/付款方式分流
  '2026-09-30 12:00:00,餐饮美食,星巴克,/,咖啡,支出,35.50,花呗,交易成功,2026093029020999060000007\t,\t,,',
  '2026-09-30 13:00:00,餐饮美食,星巴克,/,咖啡,支出,35.50,花呗&焕新折扣,交易成功,2026093029020999060000008\t,\t,,',
  '2026-09-29 12:00:00,投资理财,余额宝,/,自动转入,不计收支,500.00,账户余额,交易成功,2026092929020999060000009\t,\t,,',
  '',
].join('\n');

// ══════════════════════════════════════════════════════════════
describe('微信账单导入：划转不再丢弃', () => {
  it('27 类划转行被救回来，自转被跳过，普通消费按支付方式落账户', async () => {
    const { db, map } = makeDb();
    const zip = writePlainZip('wechat.zip', '微信支付账单.csv', WECHAT_CSV);

    const res = await importBillZip(db, zip, 'wechat', PWD, 7, 1, undefined, map);
    const rows = rowsOf(db);

    const transfers = rows.filter((r) => r.type === 'transfer');
    // 实测 4 笔真划转（工行转零钱通 / 零钱通转工行 / 建行转零钱通 / 中行转零钱通）
    expect(transfers).toHaveLength(4);
    // "来自零钱" 1 笔自转 + "转出失败" 1 笔 → 都不该出现在库里
    expect(rows.filter((r) => r.name.includes('零钱通'))).toHaveLength(0);

    const byName = (n: string): string => transfers.find((r) => r.name.includes(n))?.name ?? '';

    // 方向：转出侧 accountId / 转入侧 toAccountId
    const inFromBank = transfers.find((r) => r.amount === 1000)!;
    expect(inFromBank.accountId).toBe(map[ACCOUNT_NAMES.icbc]);
    expect(inFromBank.toAccountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);

    const outToBank = transfers.find((r) => r.amount === 5000)!;
    expect(outToBank.accountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);
    expect(outToBank.toAccountId).toBe(map[ACCOUNT_NAMES.icbc]);

    // 建行/中行各 1 笔
    expect(transfers.find((r) => r.amount === 3000)!.accountId).toBe(map[ACCOUNT_NAMES.ccb]);
    expect(transfers.find((r) => r.amount === 800)!.accountId).toBe(map[ACCOUNT_NAMES.boc]);

    // 余额联动：转出侧 -amount、转入侧 +amount
    // 工行卡：-1000（转零钱通）+5000（零钱通转回）-25.5（组合支付消费）
    expect(balanceOf(db, map[ACCOUNT_NAMES.icbc])).toBeCloseTo(-1000 + 5000 - 25.5, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.wechatInvest])).toBeCloseTo(
      1000 + 3000 + 800 - 5000 - 10 - 6, 6,
    );
    expect(balanceOf(db, map[ACCOUNT_NAMES.ccb])).toBeCloseTo(-3000, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.boc])).toBeCloseTo(-800, 6);

    // 普通消费按支付方式分流：零钱通/零钱→零钱通、组合支付取前段→工行卡、'/'→现金
    const expenses = rows.filter((r) => r.type === 'expense');
    expect(expenses).toHaveLength(4);
    expect(expenses.find((r) => r.amount === 10)!.accountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);
    expect(expenses.find((r) => r.amount === 6)!.accountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);
    expect(expenses.find((r) => r.amount === 25.5)!.accountId).toBe(map[ACCOUNT_NAMES.icbc]);
    // '支付方式=/' 落到兜底现金
    expect(expenses.find((r) => r.amount === 88)!.accountId).toBe(map[ACCOUNT_NAMES.fallback]);

    // 自转（"来自零钱"）被跳过并如实报告
    expect(res.selfTransfers).toBe(1);

    // 溯源四件套在划转行上照样带全
    expect(inFromBank.source).toBe('wechat');
    expect(inFromBank.externalId).toBe('4200003148202609057500001');
    expect(inFromBank.paymentMethod).toBe('工商银行储蓄卡(1230)');
    expect(inFromBank.status).toBe('支付成功');

    expect(res.imported).toBe(rows.length);
    db.close();
  });
});

describe('支付宝账单导入：花呗还款变成划转', () => {
  it('还款成功行落成 银行卡/余额宝/现金 → 花呗 的划转，其余状态继续丢弃', async () => {
    const { db, map } = makeDb();
    const zip = writePlainZip('alipay.zip', 'alipay.csv', ALIPAY_CSV);

    const res = await importBillZip(db, zip, 'alipay', PWD, 7, 1, undefined, map);
    const rows = rowsOf(db);
    const transfers = rows.filter((r) => r.type === 'transfer');

    // 实测 10 笔还款成功 → 3 笔（片段里放了 3 笔）
    expect(transfers).toHaveLength(3);
    for (const t of transfers) expect(t.toAccountId).toBe(map[ACCOUNT_NAMES.huabei]);

    // 还款 1：工行卡 → 花呗
    const t1 = transfers.find((r) => r.amount === 2450.4)!;
    expect(t1.accountId).toBe(map[ACCOUNT_NAMES.icbc]);
    // 还款 2：余额宝 → 花呗
    expect(transfers.find((r) => r.amount === 211.76)!.accountId).toBe(map[ACCOUNT_NAMES.alipayInvest]);
    // 还款 3：农信卡没建账户 → resolveAccountName 落兜底「现金」（它本身是设计好的兜底，
    // 现金账户存在，所以不算"账户不存在"，不该出现在降级报告里）
    expect(transfers.find((r) => r.amount === 547.19)!.accountId).toBe(map[ACCOUNT_NAMES.fallback]);
    expect(res.unmappedTransfers).toBeUndefined();

    // 还款失败 / 免押 / 解冻：一条都不能变成流水
    for (const bad of [175.4, 0]) {
      expect(rows.filter((r) => r.amount === bad)).toHaveLength(0);
    }

    // 花呗余额：收到 3 笔还款共 3075.35，支出 35.50+35.50
    expect(balanceOf(db, map[ACCOUNT_NAMES.huabei])).toBeCloseTo(2450.4 + 211.76 + 547.19 - 35.5 - 35.5, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.icbc])).toBeCloseTo(-2450.4, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.alipayInvest])).toBeCloseTo(-211.76, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.fallback])).toBeCloseTo(-547.19, 6); // 还款是从付款账户**转出**

    // 普通消费：花呗 与 花呗&焕新折扣 都落花呗
    const huabei = rows.filter((r) => r.type === 'expense' && r.accountId === map[ACCOUNT_NAMES.huabei]);
    expect(huabei).toHaveLength(2);
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════
describe('importTransactions(accountMap)：直接喂 ParsedTx', () => {
  const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
    date: 1_700_000_000_000,
    amount: 10,
    type: 'expense',
    merchant: '某商户',
    platform: 'alipay',
    source: 'alipay',
    ...over,
  });

  it('分流开启：每行按 paymentMethod 落到对应账户', () => {
    const { db, map } = makeDb();
    importTransactions(
      db,
      [
        tx({ amount: 100, paymentMethod: '花呗' }),
        tx({ amount: 200, paymentMethod: '花呗&焕新折扣' }),
        tx({ amount: 300, paymentMethod: '余额宝' }),
        tx({ amount: 400, paymentMethod: '工商银行储蓄卡(1230)' }),
        tx({ amount: 500, paymentMethod: '零钱' }),
        tx({ amount: 600, paymentMethod: null }),
        tx({ amount: 700, paymentMethod: '不存在的渠道' }),
      ],
      7,
      { accountMap: map },
    );
    const rows = rowsOf(db);
    expect(rows.find((r) => r.amount === 100)!.accountId).toBe(map[ACCOUNT_NAMES.huabei]);
    expect(rows.find((r) => r.amount === 200)!.accountId).toBe(map[ACCOUNT_NAMES.huabei]);
    expect(rows.find((r) => r.amount === 300)!.accountId).toBe(map[ACCOUNT_NAMES.alipayInvest]);
    expect(rows.find((r) => r.amount === 400)!.accountId).toBe(map[ACCOUNT_NAMES.icbc]);
    // 微信渠道在支付宝账单里也认（渠道名全局唯一，不按平台分流）
    expect(rows.find((r) => r.amount === 500)!.accountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);
    // null 与未识别 → 现金
    expect(rows.find((r) => r.amount === 600)!.accountId).toBe(map[ACCOUNT_NAMES.fallback]);
    expect(rows.find((r) => r.amount === 700)!.accountId).toBe(map[ACCOUNT_NAMES.fallback]);
    db.close();
  });

  it('分流开启：划转落双边账户并联动双边余额', () => {
    const { db, map } = makeDb();
    importTransactions(
      db,
      [
        tx({
          type: 'transfer',
          amount: 1000,
          fromAccountName: ACCOUNT_NAMES.icbc,
          toAccountName: ACCOUNT_NAMES.wechatInvest,
        }),
        tx({
          type: 'transfer',
          amount: 500,
          fromAccountName: ACCOUNT_NAMES.wechatInvest,
          toAccountName: ACCOUNT_NAMES.huabei,
        }),
      ],
      7,
      { accountMap: map },
    );
    const rows = rowsOf(db);
    expect(rows[0].toAccountId).toBe(map[ACCOUNT_NAMES.wechatInvest]);
    expect(rows[1].toAccountId).toBe(map[ACCOUNT_NAMES.huabei]);
    expect(balanceOf(db, map[ACCOUNT_NAMES.icbc])).toBeCloseTo(-1000, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.wechatInvest])).toBeCloseTo(1000 - 500, 6);
    expect(balanceOf(db, map[ACCOUNT_NAMES.huabei])).toBeCloseTo(500, 6);
    db.close();
  });

  it('划转的两端是同一账户时余额不动（自转不产生噪声）', () => {
    const { db, map } = makeDb();
    importTransactions(
      db,
      [
        tx({
          type: 'transfer',
          amount: 100,
          fromAccountName: ACCOUNT_NAMES.wechatInvest,
          toAccountName: ACCOUNT_NAMES.wechatInvest,
        }),
      ],
      7,
      { accountMap: map },
    );
    expect(balanceOf(db, map[ACCOUNT_NAMES.wechatInvest])).toBeCloseTo(0, 6);
    expect(rowsOf(db)[0].toAccountId).toBeNull();
    db.close();
  });

  it('账户不存在时降级到 fallbackAccountId 并报告，绝不丢行也不崩', () => {
    const { db, map } = makeDb();
    const res = importTransactions(
      db,
      [
        tx({
          type: 'transfer',
          amount: 1000,
          fromAccountName: '用户自建的某个账户',
          toAccountName: ACCOUNT_NAMES.huabei,
        }),
        tx({ amount: 50, paymentMethod: '花呗' }),
      ],
      7,
      { accountMap: map },
    );
    const rows = rowsOf(db);
    expect(rows).toHaveLength(2); // 两行都在
    expect(rows[0].accountId).toBe(7); // 降级到兜底
    expect(rows[0].toAccountId).toBe(map[ACCOUNT_NAMES.huabei]); // 已知的一端照常联动
    expect(res.unmappedTransfers).toEqual({ 用户自建的某个账户: 1 });
    // 降级侧**不加钱**（否则会凭空增记），只有转出侧减
    expect(balanceOf(db, 7)).toBeCloseTo(-1000, 6);
    db.close();
  });

  it('fallbackAccountId 可以显式指定，不跟随 accountId 变化', () => {
    const { db, map } = makeDb();
    // 分流表里**故意没有「现金」**：这样"认不出渠道"才会走降级分支，
    // 否则它会规规矩矩落进 map 里的现金账户（那是对的行为，不是降级）
    const partial: AccountMap = { ...map };
    delete partial[ACCOUNT_NAMES.fallback];
    importTransactions(db, [tx({ amount: 88, paymentMethod: null })], 3, {
      accountMap: partial,
      fallbackAccountId: 5,
    });
    expect(rowsOf(db)[0].accountId).toBe(5);
    expect(balanceOf(db, 5)).toBeCloseTo(-88, 6);
    db.close();
  });

  it('渠道认得出、账户也存在时走正常分流，不受 fallbackAccountId 影响', () => {
    const { db, map } = makeDb();
    importTransactions(db, [tx({ amount: 88, paymentMethod: '花呗' })], 3, {
      accountMap: map,
      fallbackAccountId: 5,
    });
    expect(rowsOf(db)[0].accountId).toBe(map[ACCOUNT_NAMES.huabei]);
    db.close();
  });

  it('去重在分流后按目标账户判重（同一账户内的重复行仍会被拦）', () => {
    const { db, map } = makeDb();
    const t = tx({ amount: 100, paymentMethod: '花呗', externalId: null, source: null });
    const res = importTransactions(db, [t, { ...t }], 7, { accountMap: map });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
    db.close();
  });

  it('分流后有 externalId 仍走 (source, externalId) 精确去重', () => {
    const { db, map } = makeDb();
    const t = tx({ amount: 100, paymentMethod: '花呗', externalId: 'X1' });
    const res = importTransactions(db, [t, { ...t }], 7, { accountMap: map });
    expect(res.imported).toBe(1);
    expect(res.skipped).toBe(1);
    db.close();
  });
});

// ══════════════════════════════════════════════════════════════
describe('向后兼容：不传 accountMap 时行为与改造前完全一致', () => {
  const tx = (over: Partial<ParsedTx> = {}): ParsedTx => ({
    date: 1_700_000_000_000,
    amount: 10,
    type: 'expense',
    merchant: '某商户',
    ...over,
  });

  it('所有行都落 accountId，忽略 paymentMethod', () => {
    const { db, map } = makeDb();
    importTransactions(
      db,
      [
        tx({ amount: 100, paymentMethod: '花呗' }),
        tx({ amount: 200, paymentMethod: '工商银行储蓄卡(1230)' }),
        tx({ amount: 300, paymentMethod: '零钱' }),
      ],
      7,
      { spaceId: 1 },
    );
    for (const r of rowsOf(db)) expect(r.accountId).toBe(7);
    expect(balanceOf(db, 7)).toBeCloseTo(-600, 6);
    // 其它账户分文未动
    for (const id of [1, 2, 3, 4, 5, 6]) expect(balanceOf(db, id)).toBeCloseTo(0, 6);
    expect(map[ACCOUNT_NAMES.fallback]).toBe(7);
    db.close();
  });

  it('划转只落转账出侧、不联动对端、toAccountId 为 NULL（老行为没有对端概念）', () => {
    const { db } = makeDb();
    const res = importTransactions(
      db,
      [
        tx({
          type: 'transfer',
          amount: 1000,
          fromAccountName: ACCOUNT_NAMES.icbc,
          toAccountName: ACCOUNT_NAMES.wechatInvest,
        }),
      ],
      7,
    );
    const rows = rowsOf(db);
    expect(rows[0].accountId).toBe(7);
    expect(rows[0].toAccountId).toBeNull();
    expect(balanceOf(db, 7)).toBeCloseTo(-1000, 6);
    // 关键：不能因为"看到两个账户名"就偷偷加钱到零钱通
    expect(balanceOf(db, 1)).toBeCloseTo(0, 6);
    expect(res.unmappedTransfers).toBeUndefined();
    db.close();
  });

  it('位置参数（老签名 importTransactions(db, txs, accountId, spaceId)）仍然可用', () => {
    const { db } = makeDb();
    const res = importTransactions(db, [tx({ amount: 10, paymentMethod: '花呗' })], 7, 1);
    expect(res.imported).toBe(1);
    expect(rowsOf(db)[0].accountId).toBe(7);
    const sp = db.prepare('SELECT spaceId FROM transactions').get() as { spaceId: number };
    expect(sp.spaceId).toBe(1);
    db.close();
  });

  it('importBillZip 不传 accountMap 时，所有行落单一账户且无划转', async () => {
    const { db } = makeDb();
    const zip = writePlainZip('wechat-nomap.zip', 'wechat.csv', WECHAT_CSV);
    await importBillZip(db, zip, 'wechat', PWD, 7);
    const rows = rowsOf(db);
    for (const r of rows) expect(r.accountId).toBe(7);
    expect(rows.filter((r) => r.type === 'transfer')).toHaveLength(0);
    expect(rows.every((r) => r.toAccountId === null)).toBe(true);
    db.close();
  });
});
