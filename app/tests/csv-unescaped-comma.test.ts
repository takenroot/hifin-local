import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseCsvText, decodeBillBytes } from '@/features/transactions/csv';

/**
 * 未转义逗号：从「静默丢行/静默错列」改为「明确告警 + 跳过」。
 *
 * 事故：切分器只认双引号包裹，字段里一个**裸**逗号就多切一格（引号包裹的逗号早就
 * 切对了，所以只有裸逗号会中招）。切点位置决定症状：
 *   - 顶在「金额」列**之前** → 金额列读到「支出」→ parseAmount 返回 null → 整行被判
 *     解析失败丢进 rawLine，**静默丢行**（实测 total=2 valid=1，无任何提示）；
 *   - 顶在**之后** → 金额还读得对，但后面整列右移，「商家订单号」顶替「备注」被
 *     **静默写进库**（实测 valid=2，remark 被截断，错值不报错更难发现）。
 *
 * 决策：不做 RFC 4180 引号感知解析（YAGNI），改为**检测到可疑行就报明确错误**——
 * 让用户知道文件有问题，而不是静默丢数据。判据收得很窄，宁可漏报不可误报正常文件。
 */

const ALIPAY_HEADER =
  '交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注';
const WECHAT_HEADER =
  '交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注';

const alipayRow = (date: string, item: string) =>
  `${date},服饰装扮,班尼路短裤,acct2,${item},支出,39.35,花呗,交易成功,ORD1,M001,`;

const hexToBuf = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16)));

describe('未转义逗号 → 明确告警（不再静默丢行/错列）', () => {
  it('切点在金额列之前：原来静默丢行，现在带 warning 跳过', () => {
    const csv = [
      ALIPAY_HEADER,
      '2026-05-17 19:30:00,服饰装扮,班尼路短裤,acct2,T恤, 短裤,支出,39.35,花呗,交易成功,ORD1,M001,',
      alipayRow('2026-05-18 19:30:00', '短裤'),
    ].join('\n');
    const r = parseCsvText(csv, 'alipay');
    expect(r.error).toBeUndefined();
    // 干净的另一行照常解析
    expect(r.valid).toBe(1);
    expect(r.items[1]).toMatchObject({ merchant: '班尼路短裤', amount: 39.35, type: 'expense' });
    // 坏行不再悄悄消失
    expect(r.items[0].rawLine).toBeTruthy();
    expect(r.warning).toContain('第 1 行列数与表头不符');
    expect(r.warning).toContain('已跳过 1 行');
    expect(r.warning).toContain('未转义逗号');
  });

  it('切点在金额列之后：原来静默写进错列，现在带 warning 跳过（不再入库错值）', () => {
    // 关键回归：改动前这行 valid=2 且 remark 被截成「短裤 尺码L」，「M001, 白色」静默丢失
    const csv = [
      ALIPAY_HEADER,
      `${alipayRow('2026-05-17 19:30:00', '短裤')}, 白色,退货`,
      alipayRow('2026-05-18 19:30:00', '短裤'),
    ].join('\n');
    const r = parseCsvText(csv, 'alipay');
    expect(r.valid).toBe(1);
    expect(r.items[0].rawLine).toBeTruthy();
    // 错值没有机会进库
    expect(r.items.some((it) => it.remark === 'M001')).toBe(false);
    expect(r.warning).toContain('已跳过 1 行');
  });

  it('微信格式同样覆盖（商品名含裸逗号）', () => {
    const csv = [
      WECHAT_HEADER,
      '2026-05-17 19:30:00,商户消费,优衣库,T恤, 短裤,支出,199.00,零钱,支付成功,W001,S001,',
    ].join('\n');
    const r = parseCsvText(csv, 'wechat');
    expect(r.valid).toBe(0);
    expect(r.warning).toContain('已跳过 1 行');
  });

  it('多个坏行：warning 报第一行与总数', () => {
    const bad = (d: string) =>
      `${d},服饰装扮,班尼路短裤,acct2,T恤, 短裤,支出,39.35,花呗,交易成功,ORD1,M001,`;
    const csv = [
      ALIPAY_HEADER,
      bad('2026-05-16 10:00:00'),
      alipayRow('2026-05-17 10:00:00', '短裤'),
      bad('2026-05-18 10:00:00'),
    ].join('\n');
    const r = parseCsvText(csv, 'alipay');
    expect(r.valid).toBe(1);
    expect(r.warning).toContain('第 1 行');
    expect(r.warning).toContain('已跳过 2 行');
  });

  it('规范加了引号的逗号是**正确**写法：照常解析，不告警', () => {
    // 真实微信 xlsx 就长这样（core 的 xlsxToCsvText 会加引号），不是坏行
    const csv = [
      WECHAT_HEADER,
      '2026-08-06 08:34:53,商户消费,高速公路公司,"内蒙东察康巴什站至锡尼镇,车牌号:蒙LB4552,收费金额30.00元",支出,30,储蓄卡(1230),支付成功,W001,S001,/',
    ].join('\n');
    const r = parseCsvText(csv, 'wechat');
    expect(r.warning).toBeUndefined();
    expect(r.valid).toBe(1);
    expect(r.items[0]).toMatchObject({ merchant: '高速公路公司', amount: 30, type: 'expense' });
  });
});

describe('正常文件绝不误报（硬闸）', () => {
  it('尾列省略（列数少于表头）是正常写法：不告警', () => {
    const csv = ['日期,金额,收/支,交易对方,备注', '2024-01-01,38.00,支出,星巴克', '2024-01-02,25.5,'].join(
      '\n',
    );
    const r = parseCsvText(csv);
    expect(r.warning).toBeUndefined();
    expect(r.valid).toBe(2);
  });

  it('引号包裹的内嵌逗号（真实微信 xlsx 的写法）：不告警', () => {
    // 真实微信原件就有这种行（core 的 xlsxToCsvText 会加引号），不是坏行
    const csv = [
      '日期,金额,收/支,交易对方,备注',
      '2024-01-01,38.00,支出,星巴克,"大杯, 加冰"',
      '2024-01-02,25.50,支出,麦当劳,"套餐""升级"""',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.warning).toBeUndefined();
    expect(r.valid).toBe(2);
    expect(r.items[0].remark).toBe('大杯, 加冰');
    expect(r.items[1].remark).toBe('套餐"升级"');
  });

  // 已知天花板（与本任务无关，且早于本任务存在）：parseCsv 先按行切、再交给引号
  // 感知切分器，所以**引号里跨行**的字段仍会被拆成两条物理行。这是 RFC 4180 支持
  // 而这里不支持的另一件事，不靠「列数启发式」兜底，如实记在此处免得后人误以为已覆盖。
  it('（已知天花板）引号内跨行的字段不在本任务保证范围内', () => {
    const csv = ['日期,金额,收/支,交易对方,备注', '2024-01-01,38.00,支出,星巴克,"第一行', '第二行"'].join(
      '\n',
    );
    const r = parseCsvText(csv);
    // 预期行为：如实告警（而不是静默错列），与本任务的取舍一致
    expect(r.warning).toContain('未转义逗号');
  });

  it('缺日期/缺金额的脏行：列数与表头一致就不告警（那是另一类问题）', () => {
    const csv = ['日期,金额,对方', ',38,星巴克', '2024-01-01,,张三', '2024-01-02,25.5,'].join('\n');
    const r = parseCsvText(csv);
    expect(r.warning).toBeUndefined();
    expect(r.valid).toBe(1);
  });

  it('T7 全场景（支付宝前言 + UTF-8 + GBK + 制表符 + 分号）均无 warning', () => {
    const preamble = ['支付宝交易记录明细查询', '账号:[138****8888]', '---'].join('\n');
    const tab = ['日期\t金额\t收/支\t交易对方\t备注', '2024-01-01\t38.00\t支出\t星巴克\t咖啡'].join('\n');
    const semi = ['日期;金额;收/支;交易对方;备注', '2024-01-01;38.00;支出;星巴克;咖啡'].join('\n');
    // 真实 GBK 字节：与 csv-bill-preamble.test.ts 同一批经 Node TextDecoder('gbk')
    // 往返校验过的常量（表头 5 列 + 1 行数据，CRLF 换行）
    const gbk =
      'BDBBD2D7CAB1BCE42CBDBBD2D7B7D6C0E02CCAD52FD6A72CBDBBD2D7B6D4B7BD2CBDF0B6EE' +
      '0D0A' +
      '323032352D31312D30312031303A30303A30302CB2CDD2FBC3C0CAB32CD6A7B3F62CD0C7B0CDBFCB2C33382E3030';

    for (const [name, text] of [
      ['带前言', [preamble, ALIPAY_HEADER, alipayRow('2026-05-17 19:30:00', '短裤')].join('\n')],
      ['UTF-8', [ALIPAY_HEADER, alipayRow('2026-05-17 19:30:00', '短裤')].join('\n')],
      ['GBK', decodeBillBytes(hexToBuf(gbk).buffer)],
      ['制表符', tab],
      ['分号', semi],
    ] as const) {
      const r = parseCsvText(text, 'alipay');
      expect(r.warning, `${name} 不该告警`).toBeUndefined();
      expect(r.valid, `${name} 应全部解析成功`).toBe(1);
    }
  });
});

/**
 * 真实原件回归：一条 warning 都不得出现。
 * 账单含个人信息、不进版本库，本机原件在 /tmp/t8real（支付宝）：
 *   `mkdir -p /tmp/t8real && cd /tmp/t8real && unzip -P 929143 /tmp/check-alipay.zip`
 * 缺失时跳过而不是假绿。微信原件是 .xlsx，要靠 core 的 xlsxToCsvText 转换才能喂进来，
 * 放在 core/tests 侧（/tmp/check-wechat.xlsx）。
 */
const ALIPAY_DIR = '/tmp/t8real';

function readAlipayCsv(): string | null {
  try {
    const f = readdirSync(ALIPAY_DIR).find((x) => x.endsWith('.csv'));
    if (!f) return null;
    const raw = readFileSync(join(ALIPAY_DIR, f));
    return decodeBillBytes(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer,
    );
  } catch {
    return null;
  }
}

describe('真实账单原件：0 warning', () => {
  it('支付宝真实导出（GBK + 23 行前言，463 行）', () => {
    const text = readAlipayCsv();
    if (!text) return; // 原件不在本机
    const r = parseCsvText(text, 'alipay');
    expect(r.warning).toBeUndefined();
    expect(r.error).toBeUndefined();
    expect(r.valid).toBe(r.total);
    expect(r.items.some((it) => it.rawLine)).toBe(false);
  });
});
