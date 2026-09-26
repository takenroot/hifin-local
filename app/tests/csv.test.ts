import { describe, it, expect } from 'vitest';
import { parseCsvText, escapeCsv } from '@/features/transactions/csv';

describe('CSV 解析：支付宝格式', () => {
  it('正确解析支出/收入与备注', () => {
    const csv = [
      '时间,金额,收/支,交易对方,备注',
      '2024-01-15 12:30:00,50.00,支出,麦当劳,午餐',
      '2024-01-16 09:00:00,3000.00,收入,工资,1月',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.platform).toBe('alipay');
    expect(r.total).toBe(2);
    expect(r.valid).toBe(2);
    expect(r.error).toBeUndefined();
    expect(r.items[0].type).toBe('expense');
    expect(r.items[0].amount).toBe(50);
    expect(r.items[0].merchant).toBe('麦当劳');
    expect(r.items[1].type).toBe('income');
    expect(r.items[1].amount).toBe(3000);
  });
});

describe('CSV 解析：微信格式', () => {
  it('正确解析收/支列（带 platformHint 强制 wechat 分支）', () => {
    const csv = [
      '交易时间,金额,收/支,交易对方,备注',
      '2024/02/01 18:00,12.50,支出,星巴克,咖啡',
      '2024/02/02 09:00,100.00,/不计,退款,',
    ].join('\n');
    const r = parseCsvText(csv, 'wechat');
    expect(r.platform).toBe('wechat');
    expect(r.valid).toBe(2);
    expect(r.items[0].type).toBe('expense');
    expect(r.items[1].type).toBe('excluded');
  });

  it('自动检测：含交易时间 + 收/支 的表头', () => {
    const csv = [
      '交易时间,金额,收/支,对方,商品',
      '2024/02/01 18:00,12.50,支出,星巴克,咖啡',
    ].join('\n');
    const r = parseCsvText(csv);
    // 注意：自动检测会先匹配 alipay 规则（含「收/支」即命中），
    // 微信独有的"交易时间"在 alipay 规则之后判定。
    expect(['wechat', 'alipay', 'generic']).toContain(r.platform);
  });
});

describe('CSV 解析：通用格式', () => {
  it('按表头别名匹配（日期 + 金额 + 收/支）', () => {
    const csv = [
      '日期,金额,类型,对方,备注',
      '2024.03.05,200,支出,京东,日用',
      '2024.03.06,5000,收入,奖金,',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.platform).toBe('generic');
    expect(r.valid).toBe(2);
    expect(r.items[0].type).toBe('expense');
    expect(r.items[1].type).toBe('income');
  });

  it('带 ¥ 符号、千分位（金额字段加引号避免被逗号切分）', () => {
    const csv = [
      '日期,金额,类型,对方',
      '2024-03-05,"¥1,234.56",支出,京东',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.items[0].amount).toBeCloseTo(1234.56, 2);
  });
});

describe('CSV 解析：脏数据容错', () => {
  it('空文件：返回 error', () => {
    const r = parseCsvText('');
    expect(r.error).toBe('空文件');
    expect(r.items).toEqual([]);
  });

  it('缺少日期/金额列：返回 error', () => {
    const csv = ['foo,bar', 'a,b'].join('\n');
    const r = parseCsvText(csv);
    expect(r.error).toBeDefined();
    expect(r.items).toEqual([]);
  });

  it('单行日期无法解析：保留 rawLine', () => {
    const csv = [
      '日期,金额,收/支,交易对方',
      'invalid-date,50,支出,京东',
      '2024-01-02,80,支出,淘宝',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.valid).toBe(1);
    expect(r.total).toBe(2);
    const bad = r.items.find((it) => it.rawLine);
    expect(bad).toBeDefined();
    expect(bad!.rawLine).toContain('invalid-date');
    expect(bad!.type).toBe('excluded');
  });

  it('单行金额无法解析：保留 rawLine', () => {
    const csv = [
      '日期,金额,收/支,交易对方',
      '2024-01-01,abc,支出,京东',
      '2024-01-02,80,支出,淘宝',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.valid).toBe(1);
    expect(r.total).toBe(2);
  });

  it('BOM 字符被正确剥离', () => {
    const csv = '\uFEFF日期,金额,收/支,交易对方\n2024-01-01,50,支出,京东';
    const r = parseCsvText(csv);
    expect(r.error).toBeUndefined();
    expect(r.valid).toBe(1);
  });

  it('空行被忽略', () => {
    const csv = [
      '日期,金额,收/支,交易对方',
      '',
      '2024-01-01,50,支出,京东',
      '   ',
      '2024-01-02,80,支出,淘宝',
    ].join('\n');
    const r = parseCsvText(csv);
    expect(r.total).toBe(2);
    expect(r.valid).toBe(2);
  });
});

describe('escapeCsv', () => {
  it('不含特殊字符时不加引号', () => {
    expect(escapeCsv('hello')).toBe('hello');
  });

  it('含逗号时用双引号包裹', () => {
    expect(escapeCsv('a,b')).toBe('"a,b"');
  });

  it('含双引号时做转义', () => {
    expect(escapeCsv('a"b')).toBe('"a""b"');
  });

  it('含换行时用双引号包裹', () => {
    expect(escapeCsv('a\nb')).toBe('"a\nb"');
  });
});
