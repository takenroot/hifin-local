import { describe, it, expect } from 'vitest';
import { parseCsvText } from '@/features/transactions/csv';

describe('真实账单解析回归', () => {
  it('支付宝标准导出', () => {
    const csv = `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,支付方式,交易状态,交易订单号,商家订单号,备注
2024-01-15 12:34:56,餐饮美食,星巴克咖啡,test@x,大杯拿铁,支出,38.00,支付宝,交易成功,123,456,
2024-01-15 19:01:00,转账,张三,test2,还款,收入,500.00,余额宝,交易成功,124,457,
2024-01-16 08:20:00,交通出行,滴滴出行,,打车,支出,25.50,支付宝,交易成功,125,458,`;
    const r = parseCsvText(csv, 'alipay');
    expect(r.platform).toBe('alipay');
    expect(r.valid).toBe(3);
    expect(r.total).toBe(3);
    expect(r.items[0]).toMatchObject({
      merchant: '星巴克咖啡',
      amount: 38,
      type: 'expense',
    });
    expect(r.items[1].type).toBe('income');
  });

  it('微信支付标准导出', () => {
    const csv = `交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,商户单号,备注
2024-02-01 09:00:00,商户消费,麦当劳,巨无霸套餐,支出,28.50,零钱,已支付,M001,S001,
2024-02-02 13:30:00,红包,王五,恭喜发财,收入,88.88,零钱,已收款,R001,,`;
    const r = parseCsvText(csv, 'wechat');
    expect(r.valid).toBe(2);
    expect(r.items[0].merchant).toBe('麦当劳');
    expect(r.items[1].amount).toBe(88.88);
  });

  it('通用银行 CSV（含"对方账号"和"备注"列名）', () => {
    const csv = `日期,摘要,对方,收/支,金额,余额,备注
2024-03-01,工资,公司账户,收入,12000,12000,3月薪资
2024-03-02,购物,京东商城,支出,399.00,11601,`;
    const r = parseCsvText(csv);
    expect(r.valid).toBe(2);
    expect(r.items[0].type).toBe('income');
    expect(r.items[1].merchant).toBe('京东商城');
  });

  it('字段内含制表符：不多切列，该行不丢（支付宝「交易订单号」尾部 Tab）', () => {
    // 真实账单里「交易订单号」尾部带一个 Tab。切分器若把 \t 也当分隔符就会多切一列：
    // 切在金额列之前 → 金额读到「支出」→ 整行被判解析失败丢弃；切在之后 →
    // 金额还对，但「商家订单号」会顶替「备注」被静默写进库。
    const csv = `交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注
2026-05-16 12:00:00,餐饮美食,星巴克,acct1,拿铁,支出,38.00,支付宝,交易成功,ORD1\t,M001,
2026-05-17 19:30:00,服饰装扮,班尼路短裤,acct2,短裤\t,支出,39.35,花呗,交易成功,ORD2\t,M002,短裤尺码L`;
    const r = parseCsvText(csv, 'alipay');
    expect(r.total).toBe(2);
    expect(r.valid).toBe(2);
    expect(r.items.some((it) => it.rawLine)).toBe(false);

    const row = r.items[1];
    expect(row.amount).toBe(39.35);
    expect(row.type).toBe('expense');
    expect(row.merchant).toBe('班尼路短裤');
    expect(row.billCategory).toBe('服饰装扮');
    // 尾部 Tab 归一化掉，且没有把「商家订单号」串到「备注」上
    expect(row.externalId).toBe('ORD2');
    expect(row.paymentMethod).toBe('花呗');
    expect(row.remark).toBe('短裤尺码L');
  });

  it('整份 TSV 导出照样按制表符切', () => {
    const csv = [
      '交易时间\t交易分类\t交易对方\t对方账号\t商品说明\t收/支\t金额\t收/付款方式\t交易状态\t交易订单号\t商家订单号\t备注',
      '2026-05-17 19:30:00\t服饰装扮\t班尼路短裤\tacct2\t短裤\t支出\t39.35\t花呗\t交易成功\tORD2\tM002\t',
    ].join('\n');
    const r = parseCsvText(csv, 'alipay');
    expect(r.valid).toBe(1);
    expect(r.items[0].amount).toBe(39.35);
    expect(r.items[0].merchant).toBe('班尼路短裤');
    expect(r.items[0].externalId).toBe('ORD2');
  });

  it('脏数据：缺日期、缺金额', () => {
    const csv = `日期,金额,对方
,38,星巴克
2024-01-01,,张三
2024-01-02,25.5,`;
    const r = parseCsvText(csv);
    expect(r.valid).toBe(1);  // 只有第三行有效
    expect(r.items[0].merchant).toBe(''); // last col trimmed
  });
});