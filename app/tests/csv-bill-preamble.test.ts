import { describe, it, expect } from 'vitest';
import { parseCsvText, decodeBillBytes } from '@/features/transactions/csv';

/**
 * 手动上传路径（T7）回归。
 *
 * 事故：真实支付宝导出前 23 行是导出说明，`parseCsv` 把第 1 行当表头 →
 * 找不到日期/金额列 → 整份 463 笔 valid=0；另外 `readAsText(file,'utf-8')`
 * 把 GBK 账单硬解成不报错的乱码。两条路各修一次，但根因都在共享解析器上，
 * core 的 `import-csv` CLI 同样受益。
 */

/** 支付宝导出的真实表头 + 两行数据（GBK 字节，见下方 hex 常量）。 */
const ALIPAY_HEADER = '交易时间,交易分类,收/支,交易对方,金额';
const ALIPAY_ROWS = [
  '2025-12-01 10:00:00,餐饮美食,支出,星巴克,38.00',
  '2025-12-02 19:30:00,服饰装扮,收入,优衣库,500.00',
];

/** 前言 23 行，形状照抄支付宝导出（分隔线 / 账号 / 统计 / 特别提示 / 电子回单抬头）。 */
const ALIPAY_PREAMBLE = [
  '--------------------------------------------------',
  '支付宝交易记录明细查询',
  '账号:[138****8888]',
  '姓名:[张三]',
  '起始日期:[2025-12-01 00:00:00]    终止日期:[2025-10-02 23:59:59]',
  '---------------------------------------------------------------------------',
  '导出时间:[2025-12-05 10:21:03]    总笔数:[463]',
  '---------------------------------交易记录明细列表------------------------------------',
  '序号    交易时间       交易分类  交易对方  收/支  金额',
  '',
  '共 23 笔记录',
  '',
  '------------------------------------------------------------------------------------',
  '特别提示：',
  '1. 本报表金额单位为人民币元。',
  '2. 交易时间按北京时间记录。',
  '3. 如有疑问请联系支付宝客服。',
  '',
  '电子回单',
  '回单编号：2025120500001',
  '开票日期：2025-12-05',
  '姓名：张三',
  '身份证号：310***********1234',
  '------------------------------------------------------------------------------------',
].join('\n');

const hexToBuf = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/**
 * GBK 字节常量（用 Node `TextDecoder('gbk')` 反查得到，往返校验过）。
 * 真账单含个人信息，不进版本库，所以只留同样形状的等价字节。
 */
const GBK_HEADER =
  'BDBBD2D7CAB1BCE42CBDBBD2D7B7D6C0E02CCAD52FD6A72CBDBBD2D7B6D4B7BD2CBDF0B6EE';
const GBK_ROW_1 =
  '323032352D31322D30312031303A30303A30302CB2CDD2FBC3C0CAB32CD6A7B3F62CD0C7B0CDBFCB2C33382E3030';
const GBK_ROW_2 =
  '323032352D31322D30322031393A33303A30302CB7FECACED7B0B0E72CCAD5C8EB2CD3C5D2C2BFE22C3530302E3030';
/** 前言行「支付宝交易记录明细查询」的 GBK 字节（单格，说明里才带日期/金额字样）。 */
const GBK_PREAMBLE = 'D6A7B8B6B1A6BDBBD2D7BCC7C2BCC3F7CFB8B2E9D1AF';

/** 把若干段 hex 拼成一份账单文本的字节，段间用 CRLF 换行。 */
const toBuf = (...parts: string[]): Uint8Array => {
  const segs = parts.flatMap((p, i) => (i === 0 ? [p] : ['0D0A', p]));
  const total = segs.reduce((n, p) => n + p.length / 2, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of segs) {
    out.set(hexToBuf(p), off);
    off += p.length / 2;
  }
  return out;
};

describe('账单前言剥离（支付宝真实导出形状）', () => {
  it('有前言时跳过前言、只解析表头之后的行', () => {
    const text = [ALIPAY_PREAMBLE, ALIPAY_HEADER, ...ALIPAY_ROWS].join('\n');
    const r = parseCsvText(text, 'alipay');
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(2); // 前言不再被算进 total
    expect(r.valid).toBe(2);
    expect(r.items[0]).toMatchObject({ merchant: '星巴克', amount: 38, type: 'expense' });
    expect(r.items[1]).toMatchObject({ merchant: '优衣库', amount: 500, type: 'income' });
  });

  it('前言里带「日期」的行不会被误当表头（它没有金额列）', () => {
    // 第 4 行含「日期」、第 7 行含「交易记录明细列表」：任何一条被当成表头，
    // 整份账单就又会退化成 valid=0。
    const text = ['起始日期,终止日期', '2025-12-01,2025-10-02', ALIPAY_HEADER, ...ALIPAY_ROWS].join('\n');
    const r = parseCsvText(text, 'alipay');
    expect(r.valid).toBe(2);
    expect(r.items[0].merchant).toBe('星巴克');
  });

  it('表头在第 1 行时一行都不切（普通 CSV 不被误伤）', () => {
    const csv = ['日期,金额,收/支,交易对方,备注', '2024-01-01,38.00,支出,星巴克,咖啡'].join('\n');
    const r = parseCsvText(csv);
    expect(r.total).toBe(1);
    expect(r.valid).toBe(1);
    expect(r.items[0].merchant).toBe('星巴克');
  });

  it('空文件', () => {
    const r = parseCsvText('');
    expect(r).toMatchObject({ total: 0, valid: 0, error: '空文件' });
  });

  it('纯前言、全程没有表头：如实报错而不是把说明行当数据', () => {
    const r = parseCsvText(ALIPAY_PREAMBLE, 'alipay');
    expect(r.valid).toBe(0);
    expect(r.error).toBe('未识别到日期/金额列，请确保表头包含"日期"和"金额"');
  });

  it('带前言 + 制表符分隔：分隔符按表头行猜（不再是前言的分隔线）', () => {
    const lines = ['前面几行说明', '日期\t金额\t收/支\t交易对方', '2024-01-01\t38.00\t支出\t星巴克'];
    const r = parseCsvText(lines.join('\n'));
    expect(r.valid).toBe(1);
    expect(r.items[0]).toMatchObject({ merchant: '星巴克', amount: 38, type: 'expense' });
  });
});

describe('账单字节解码（手动上传路径）', () => {
  it('GBK 账单：解出中文，并完整解析出全部行', () => {
    const bytes = toBuf(GBK_HEADER, GBK_ROW_1, GBK_ROW_2);
    const text = decodeBillBytes(bytes.buffer);
    expect(text).toContain('交易时间'); // 不是乱码
    const r = parseCsvText(text, 'alipay');
    expect(r.error).toBeUndefined();
    expect(r.valid).toBe(2);
    expect(r.items[0].merchant).toBe('星巴克');
  });

  it('GBK 账单 + 前言：一路走到 valid=N（解码与剥离两段一起过）', () => {
    const bytes = toBuf(GBK_PREAMBLE, GBK_HEADER, GBK_ROW_1, GBK_ROW_2);
    const r = parseCsvText(decodeBillBytes(bytes.buffer), 'alipay');
    expect(r.error).toBeUndefined();
    expect(r.total).toBe(2);
    expect(r.valid).toBe(2);
    expect(r.items[0].merchant).toBe('星巴克');
    expect(r.items[1].merchant).toBe('优衣库');
  });

  it('UTF-8 账单（含中文）：UTF-8 优先，不被 GBK 误吃成乱码', () => {
    const bytes = new TextEncoder().encode([ALIPAY_HEADER, ...ALIPAY_ROWS].join('\n'));
    const text = decodeBillBytes(bytes.buffer);
    expect(text).toContain('交易时间');
    expect(parseCsvText(text, 'alipay').valid).toBe(2);
  });

  it('纯 ASCII 账单', () => {
    const bytes = new TextEncoder().encode('Date,Amount,Memo\n2024-01-01,12.50,x');
    expect(decodeBillBytes(bytes.buffer)).toBe('Date,Amount,Memo\n2024-01-01,12.50,x');
  });
});
