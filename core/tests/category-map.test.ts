/**
 * category-map 单测
 * -----------------------------------------------------------------
 * 覆盖：
 *   - 支付宝「交易分类」每个映射项（18 个）
 *   - 微信「交易类型」每条规则（红包三类 / 退款后缀 / 零钱通 / 刻意不映射）
 *   - 收支类型闸门（支出分类配收入流水 → null，反之亦然）
 *   - 未知分类 / 空值 / 未知平台 → null
 *
 * 映射表里的键是**实测账单里真实出现过的值**，所以这里除了逐条钉住映射表，
 * 还额外断言"表里的每个键都被用例覆盖到"——新增分类却忘了加用例时当场红，
 * 而不是悄悄少覆盖一条。
 */

import { describe, it, expect } from 'vitest';
import {
  ALIPAY_BILL_CATEGORIES,
  BILL_CATEGORY_TYPES,
  WECHAT_BILL_CATEGORIES,
  resolveAlipayBillCategory,
  resolveBillCategory,
  resolveWechatBillCategory,
} from '../src/bill/category-map.ts';

/** 支付宝表：账单值 → [分类名, 该分类的收支方向] */
const ALIPAY_CASES: Array<[string, string, 'expense' | 'income']> = [
  ['餐饮美食', '日常餐饮', 'expense'],
  ['交通出行', '公共交通', 'expense'],
  ['服饰装扮', '服饰', 'expense'],
  ['日用百货', '日用百货', 'expense'],
  ['数码电器', '数码电器', 'expense'],
  ['文化休闲', '电影演出', 'expense'],
  ['医疗健康', '看病就医', 'expense'],
  ['充值缴费', '通讯话费', 'expense'],
  ['美容美发', '美妆护肤', 'expense'],
  ['家居家装', '其他支出', 'expense'],
  ['生活服务', '其他支出', 'expense'],
  ['商业服务', '其他支出', 'expense'],
  ['爱车养车', '其他支出', 'expense'],
  ['投资理财', '其他支出', 'expense'],
  ['信用借还', '其他支出', 'expense'],
  ['其他', '其他支出', 'expense'],
  ['退款', '其他收入', 'income'],
  ['收入', '其他收入', 'income'],
];

/** 微信表：账单值 → 期望分类名（null = 刻意不映射） */
const WECHAT_CASES: Array<[string, string | null]> = [
  ['微信红包', '人情往来'],
  ['微信红包（单发）', '人情往来'],
  ['微信红包（群红包）', '人情往来'],
  // 实测账单里真实出现的退款形态
  ['转账-退款', '其他收入'],
  ['微信红包-退款', '其他收入'],
  ['中铁网络-退款', '其他收入'],
  ['蜜雪冰城-退款', '其他收入'],
  ['酒店民宿钱管家-退款', '其他收入'],
  ['嗨皮打水-退款', '其他收入'],
  ['北京月之暗面科技股份有限公司-退款', '其他收入'],
  // 账户内部划转
  ['转入零钱通-来自零钱', null],
  ['转入零钱通-来自工商银行(1230)', null],
  ['转入零钱通-来自建设银行(9151)', null],
  ['零钱通转出-到工商银行(1230)', null],
  // 语义不足，留给规则引擎
  ['商户消费', null],
  ['扫二维码付款', null],
  ['转账', null],
  // 未覆盖
  ['其他', null],
  ['不存在的类型', null],
];

describe('resolveBillCategory — 支付宝「交易分类」', () => {
  it.each(ALIPAY_CASES)('%s → %s', (bill, expected, txType) => {
    expect(resolveBillCategory('alipay', bill, txType)).toBe(expected);
  });

  it('映射表覆盖了实测账单里出现过的全部分类值，且每个键都有对应用例', () => {
    const covered = new Set(ALIPAY_CASES.map(([b]) => b));
    for (const key of Object.keys(ALIPAY_BILL_CATEGORIES)) {
      expect(covered.has(key), `支付宝映射表新增了「${key}」但没有对应用例`).toBe(true);
    }
    expect(Object.keys(ALIPAY_BILL_CATEGORIES).length).toBe(18);
  });

  it('去首尾空白后仍能匹配', () => {
    expect(resolveBillCategory('alipay', '  交通出行  ', 'expense')).toBe('公共交通');
  });

  it('未知分类 → null', () => {
    expect(resolveBillCategory('alipay', '不存在的分类', 'expense')).toBeNull();
    expect(resolveAlipayBillCategory('房屋租赁')).toBeNull();
  });

  it('收支类型不匹配 → null（收入分类不能配支出流水，反之亦然）', () => {
    // 退款/收入 映射到收入类分类，配一笔支出流水必须拒绝
    expect(resolveBillCategory('alipay', '退款', 'expense')).toBeNull();
    expect(resolveBillCategory('alipay', '收入', 'expense')).toBeNull();
    // 支出类分类配收入流水同样拒绝
    expect(resolveBillCategory('alipay', '餐饮美食', 'income')).toBeNull();
    expect(resolveBillCategory('alipay', '交通出行', 'income')).toBeNull();
  });

  it('空值 / null / undefined → null', () => {
    expect(resolveBillCategory('alipay', '', 'expense')).toBeNull();
    expect(resolveBillCategory('alipay', null, 'expense')).toBeNull();
    expect(resolveBillCategory('alipay', undefined, 'income')).toBeNull();
  });
});

describe('resolveBillCategory — 微信「交易类型」', () => {
  it.each(WECHAT_CASES)('%s → %s', (bill, expected) => {
    // 这一层只测"字符串 → 分类名"，收支闸门在下面单独测
    expect(resolveWechatBillCategory(bill)).toBe(expected);
  });

  it('精确表里的每个键都有对应用例（新增类型忘了加用例就红）', () => {
    const covered = new Set(WECHAT_CASES.map(([b]) => b));
    for (const key of Object.keys(WECHAT_BILL_CATEGORIES)) {
      expect(covered.has(key), `微信映射表新增了「${key}」但没有对应用例`).toBe(true);
    }
  });

  it('红包映射到人情往来，但只对"支出方向"的红包生效', () => {
    // 发出红包（群/单发）→ 人情往来
    expect(resolveBillCategory('wechat', '微信红包（群红包）', 'expense')).toBe('人情往来');
    expect(resolveBillCategory('wechat', '微信红包（单发）', 'expense')).toBe('人情往来');
    // 收到红包是收入流水，人情往来是支出类分类 → 必须拒绝
    expect(resolveBillCategory('wechat', '微信红包', 'income')).toBeNull();
  });

  it('退款一律是收入：配支出流水时被闸门拦下', () => {
    expect(resolveBillCategory('wechat', '转账-退款', 'income')).toBe('其他收入');
    expect(resolveBillCategory('wechat', '转账-退款', 'expense')).toBeNull();
    expect(resolveBillCategory('wechat', '微信红包-退款', 'income')).toBe('其他收入');
    expect(resolveBillCategory('wechat', '微信红包-退款', 'expense')).toBeNull();
  });

  it('"退款"后缀优先于前缀：微信红包-退款 不会被当成人情往来', () => {
    // 名字长得像红包，但它是退回来的钱 → 进账
    expect(resolveWechatBillCategory('微信红包-退款')).toBe('其他收入');
    expect(resolveWechatBillCategory('微信红包')).toBe('人情往来');
  });

  it('零钱通转入/转出（账户内部划转）→ null，两种方向都不映射', () => {
    for (const txType of ['expense', 'income'] as const) {
      expect(resolveBillCategory('wechat', '转入零钱通-来自零钱', txType)).toBeNull();
      expect(resolveBillCategory('wechat', '零钱通转出-到工商银行(1230)', txType)).toBeNull();
    }
  });

  it('商户消费 / 扫二维码付款 / 转账 → null（留给规则引擎）', () => {
    for (const bill of ['商户消费', '扫二维码付款', '转账']) {
      expect(resolveBillCategory('wechat', bill, 'expense')).toBeNull();
      expect(resolveBillCategory('wechat', bill, 'income')).toBeNull();
    }
  });

  it('空值 / null / undefined → null', () => {
    expect(resolveBillCategory('wechat', '', 'expense')).toBeNull();
    expect(resolveBillCategory('wechat', null, 'expense')).toBeNull();
    expect(resolveBillCategory('wechat', undefined, 'expense')).toBeNull();
  });

  it('容忍 Excel 导出的反引号包裹与空白', () => {
    expect(resolveWechatBillCategory('`商户消费`')).toBeNull();
    expect(resolveWechatBillCategory(' 微信红包（群红包） ')).toBe('人情往来');
  });
});

describe('resolveBillCategory — 跨平台与闸门', () => {
  it('非 alipay/wechat 平台一律 null（银行账单里的"交易类型"语义不同）', () => {
    for (const platform of ['cmb', 'icbc', 'generic', '', null, undefined, 'ALIPAY']) {
      expect(resolveBillCategory(platform, '餐饮美食', 'expense')).toBeNull();
    }
  });

  it('平台不串味：微信的分类值拿去问支付宝只会得到 null', () => {
    expect(resolveBillCategory('alipay', '商户消费', 'expense')).toBeNull();
    expect(resolveBillCategory('alipay', '微信红包（群红包）', 'expense')).toBeNull();
  });

  it('映射表里的每个分类名都在类型表里登记过（否则闸门会形同虚设）', () => {
    const mapped = new Set<string>([
      ...Object.values(ALIPAY_BILL_CATEGORIES),
      ...Object.values(WECHAT_BILL_CATEGORIES).filter((v): v is string => v !== null),
    ]);
    for (const name of mapped) {
      expect(BILL_CATEGORY_TYPES[name], `分类名「${name}」没在 BILL_CATEGORY_TYPES 里登记收支类型`).toBeDefined();
    }
  });

  it('同名分类不会既登记为收入又登记为支出', () => {
    // 反向：类型表里的名字必须能对应到唯一方向（表是 name→type，天然唯一，
    // 这里留一条显式断言把"类型表不撒谎"钉住）
    const incomeNames = Object.entries(BILL_CATEGORY_TYPES)
      .filter(([, t]) => t === 'income')
      .map(([name]) => name);
    expect(incomeNames).toEqual(['其他收入']);
  });
});
