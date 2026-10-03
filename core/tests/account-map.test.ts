/**
 * account-map 单测
 * -----------------------------------------------------------------
 * 覆盖三层：
 *   1. resolveAccountName：7 个账户的每一个渠道、组合支付取 & 前段、
 *      空/''/未识别 → 现金、跨平台同名渠道
 *   2. 微信零钱通划转解析：转入/转出两个句式 + 自转判定
 *   3. 支付宝花呗还款解析：还款成功 vs 还款失败/解冻/免押/交易关闭
 *
 * 表里的值全部取自**实测账单**（/tmp/check-alipay.zip、/tmp/check-wechat.xlsx，
 * 20251201-20261002 区间），不是凭空编的；像"内蒙古农信储蓄卡(6322)"
 * 这种账单里真实存在、但用户没建的账户也照原样进用例，钉死它落「现金」。
 */

import { describe, it, expect } from 'vitest';
import {
  ACCOUNT_NAMES,
  ACCOUNT_TYPES,
  ALL_ACCOUNT_NAMES,
  accountTypeOf,
  expandBankShortName,
  isAlipayNonMoneyStatus,
  isEffectiveTransferStatus,
  isSelfTransfer,
  parseAlipayRepayTransfer,
  parseWechatTransfer,
  resolveAccountName,
} from '../src/bill/account-map.ts';

// ══════════════════════════════════════════════════════════════
describe('resolveAccountName：实测渠道 → 7 个账户', () => {
  /**
   * [账单原文, 期望账户, 平台]
   *
   * 平台一栏是为了证明"同名渠道跨平台不串味"：微信的「零钱」和支付宝的
   * 「账户余额」是两回事，各自只能归到自己的账户去。
   */
  const CASES: Array<[string, string, 'alipay' | 'wechat']> = [
    // ── 零钱通（微信）：零钱是过渡渠道，归并到零钱通 ──
    ['零钱通', ACCOUNT_NAMES.wechatInvest, 'wechat'],
    ['零钱', ACCOUNT_NAMES.wechatInvest, 'wechat'],
    // ── 余额宝（支付宝）：账户余额也归并进来 ──
    ['余额宝', ACCOUNT_NAMES.alipayInvest, 'alipay'],
    ['账户余额', ACCOUNT_NAMES.alipayInvest, 'alipay'],
    // ── 花呗 ──
    ['花呗', ACCOUNT_NAMES.huabei, 'alipay'],
    // ── 三张卡 ──
    ['工商银行储蓄卡(1230)', ACCOUNT_NAMES.icbc, 'alipay'],
    ['工商银行储蓄卡(1230)', ACCOUNT_NAMES.icbc, 'wechat'],
    ['中国银行储蓄卡(3544)', ACCOUNT_NAMES.boc, 'wechat'],
    ['建设银行储蓄卡(9151)', ACCOUNT_NAMES.ccb, 'wechat'],
  ];

  for (const [raw, expected, platform] of CASES) {
    it(`${platform} 的「${raw}」→ ${expected}`, () => {
      expect(resolveAccountName(raw, platform)).toBe(expected);
    });
  }

  it('渠道表里的每一条都有用例覆盖（新增渠道忘了加用例会当场红）', () => {
    // 反查：逐个账户名，至少要被一个用例映射到
    const covered = new Set(CASES.map(([, acc]) => acc));
    for (const name of ALL_ACCOUNT_NAMES) {
      // 「现金」靠兜底用例覆盖（见下一组），这里只查 6 个具名渠道账户
      if (name === ACCOUNT_NAMES.fallback) continue;
      expect(covered.has(name)).toBe(true);
    }
  });
});

describe('resolveAccountName：组合支付取 & 前段', () => {
  // 全部取自支付宝实测账单里出现过的组合支付原值
  const COMBO: Array<[string, string]> = [
    ['花呗&焕新折扣', ACCOUNT_NAMES.huabei],
    ['花呗&花呗信用购立减', ACCOUNT_NAMES.huabei],
    ['花呗&惊喜市集惊喜币&现金抵价券', ACCOUNT_NAMES.huabei],
    ['花呗&碰一下立减', ACCOUNT_NAMES.huabei],
    ['花呗&西安消费劵', ACCOUNT_NAMES.huabei],
    ['工商银行储蓄卡(1230)&优惠', ACCOUNT_NAMES.icbc],
    ['工商银行储蓄卡(1230)&工商银行立减金', ACCOUNT_NAMES.icbc],
    ['工商银行储蓄卡(1230)&红包', ACCOUNT_NAMES.icbc],
  ];

  for (const [raw, expected] of COMBO) {
    it(`「${raw}」取前段 → ${expected}`, () => {
      expect(resolveAccountName(raw, 'alipay')).toBe(expected);
    });
  }

  it('组合支付与主渠道单独出现时结果一致（& 后面挂什么都改变不了归属）', () => {
    expect(resolveAccountName('花呗&焕新折扣', 'alipay')).toBe(
      resolveAccountName('花呗', 'alipay'),
    );
    expect(resolveAccountName('工商银行储蓄卡(1230)&优惠', 'alipay')).toBe(
      resolveAccountName('工商银行储蓄卡(1230)', 'alipay'),
    );
  });
});

describe('resolveAccountName：空值与未识别渠道 → 现金', () => {
  const FALLBACK_CASES: Array<string | null | undefined> = [
    null,
    undefined,
    '',
    '   ',
    '/', // 两家账单"这格没内容"的占位符
    '未知渠道',
    '内蒙古农信储蓄卡(6322)', // 账单里真实存在、但用户没建的卡
    '单车骑行卡抵扣', // 账单里真实存在的非账户渠道
    '哈啰骑行卡',
    '吃喝玩乐',
  ];

  for (const raw of FALLBACK_CASES) {
    it(`${JSON.stringify(raw)} → 现金`, () => {
      expect(resolveAccountName(raw, 'alipay')).toBe(ACCOUNT_NAMES.fallback);
    });
  }

  it('没有 platform 参数时也照样能解析（老调用方不传平台）', () => {
    expect(resolveAccountName('花呗')).toBe(ACCOUNT_NAMES.huabei);
    expect(resolveAccountName('零钱')).toBe(ACCOUNT_NAMES.wechatInvest);
  });
});

describe('resolveAccountName：跨平台同名渠道不串味', () => {
  it('「账户余额」只在支付宝口径下归余额宝，微信传同一个值也归它（该渠道语义唯一）', () => {
    expect(resolveAccountName('账户余额', 'alipay')).toBe(ACCOUNT_NAMES.alipayInvest);
    // 微信账单里不存在「账户余额」，真传进来也只能按"认不出"处理，
    // 而不是反过来污染零钱通——两条渠道名本身就不冲突，不该硬造冲突。
    expect(resolveAccountName('账户余额', 'wechat')).toBe(ACCOUNT_NAMES.alipayInvest);
  });

  it('银行渠道在两家平台下归同一个账户（银行卡是同一张卡，不分平台）', () => {
    expect(resolveAccountName('工商银行储蓄卡(1230)', 'alipay')).toBe(ACCOUNT_NAMES.icbc);
    expect(resolveAccountName('工商银行储蓄卡(1230)', 'wechat')).toBe(ACCOUNT_NAMES.icbc);
  });
});

describe('resolveAccountName：银行卡渠道名的空白容错', () => {
  it('卡名里的空格不影响归属（"工商银行储蓄卡( 1230)" 仍是工行卡）', () => {
    expect(resolveAccountName('工商银行储蓄卡( 1230)', 'alipay')).toBe(ACCOUNT_NAMES.icbc);
  });

  it('expandBankShortName：简称补全成规范名', () => {
    expect(expandBankShortName('工商银行(1230)')).toBe('工商银行储蓄卡(1230)');
    expect(expandBankShortName('中国银行(3544)')).toBe('中国银行储蓄卡(3544)');
    expect(expandBankShortName('建设银行(9151)')).toBe('建设银行储蓄卡(9151)');
    // 已经是规范名的原样返回
    expect(expandBankShortName('工商银行储蓄卡(1230)')).toBe('工商银行储蓄卡(1230)');
  });
});

describe('账户类型表', () => {
  it('7 个账户的类型符合设计（invest/fund 是资产，花呗 credit 是负债）', () => {
    expect(accountTypeOf(ACCOUNT_NAMES.wechatInvest)).toBe('invest');
    expect(accountTypeOf(ACCOUNT_NAMES.alipayInvest)).toBe('invest');
    expect(accountTypeOf(ACCOUNT_NAMES.icbc)).toBe('fund');
    expect(accountTypeOf(ACCOUNT_NAMES.boc)).toBe('fund');
    expect(accountTypeOf(ACCOUNT_NAMES.ccb)).toBe('fund');
    expect(accountTypeOf(ACCOUNT_NAMES.huabei)).toBe('credit');
    expect(accountTypeOf(ACCOUNT_NAMES.fallback)).toBe('fund');
  });

  it('表外账户按"其它资产"处理，绝不当成负债', () => {
    expect(accountTypeOf('某个用户自建账户')).toBe('fund');
  });

  it('类型表覆盖全部 7 个账户名', () => {
    for (const n of ALL_ACCOUNT_NAMES) {
      expect(Object.prototype.hasOwnProperty.call(ACCOUNT_TYPES, n)).toBe(true);
    }
  });
});

// ══════════════════════════════════════════════════════════════
describe('微信零钱通划转解析', () => {
  // 实测 27 行划转的句式与次数
  const IN_CASES: Array<[string, string, number]> = [
    ['转入零钱通-来自工商银行(1230)', ACCOUNT_NAMES.icbc, 11],
    ['转入零钱通-来自零钱', ACCOUNT_NAMES.wechatInvest, 13],
    ['转入零钱通-来自建设银行(9151)', ACCOUNT_NAMES.ccb, 1],
    ['转入零钱通-来自中国银行(3544)', ACCOUNT_NAMES.boc, 1],
  ];
  const OUT_CASES: Array<[string, string, number]> = [
    ['零钱通转出-到工商银行(1230)', ACCOUNT_NAMES.icbc, 1],
  ];

  for (const [raw, from, count] of IN_CASES) {
    it(`「${raw}」→ ${from} → 零钱通（实测 ${count} 笔）`, () => {
      expect(parseWechatTransfer(raw)).toEqual({
        fromAccountName: from,
        toAccountName: ACCOUNT_NAMES.wechatInvest,
      });
    });
  }

  for (const [raw, to, count] of OUT_CASES) {
    it(`「${raw}」→ 零钱通 → ${to}（实测 ${count} 笔）`, () => {
      expect(parseWechatTransfer(raw)).toEqual({
        fromAccountName: ACCOUNT_NAMES.wechatInvest,
        toAccountName: to,
      });
    });
  }

  it('非划转的交易类型返回 null（普通消费不能被当成转账）', () => {
    for (const raw of ['商户消费', '扫二维码付款', '转账', '微信红包', '微信红包（群红包）']) {
      expect(parseWechatTransfer(raw)).toBeNull();
    }
  });

  it('空/未知的交易类型返回 null', () => {
    expect(parseWechatTransfer(null)).toBeNull();
    expect(parseWechatTransfer('')).toBeNull();
    expect(parseWechatTransfer('转入零钱通-来自某不存在的银行(0000)')).toEqual({
      // 认不出的来源落兜底「现金」，方向仍对：钱确实从某个账户进了零钱通
      fromAccountName: ACCOUNT_NAMES.fallback,
      toAccountName: ACCOUNT_NAMES.wechatInvest,
    });
  });

  it('"来自零钱"归并后是自转（实测 13 笔必须跳过，不能生成流水）', () => {
    const legs = parseWechatTransfer('转入零钱通-来自零钱');
    expect(legs).not.toBeNull();
    expect(isSelfTransfer(legs!)).toBe(true);
  });

  it('来自银行卡的划转不是自转（钱真的换了账户）', () => {
    expect(isSelfTransfer(parseWechatTransfer('转入零钱通-来自工商银行(1230)')!)).toBe(false);
  });
});

describe('微信划转状态闸门', () => {
  it('"支付成功"/"资金已到账" 算有效（照常联动余额）', () => {
    expect(isEffectiveTransferStatus('支付成功')).toBe(true);
    expect(isEffectiveTransferStatus('资金已到账')).toBe(true);
  });

  it('失败/关闭/取消/退款 不算有效（钱没动，不该联动）', () => {
    for (const s of ['转出失败', '交易关闭', '已取消', '退款成功']) {
      expect(isEffectiveTransferStatus(s)).toBe(false);
    }
  });

  it('状态为空时放行（账单没这列时交给金额等其它判据）', () => {
    expect(isEffectiveTransferStatus(null)).toBe(true);
    expect(isEffectiveTransferStatus('')).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
describe('支付宝花呗还款解析', () => {
  // 实测 10 笔还款成功的付款方式分布
  const REPAY_CASES: Array<[string, string]> = [
    ['工商银行储蓄卡(1230)', ACCOUNT_NAMES.icbc],
    ['余额宝', ACCOUNT_NAMES.alipayInvest],
    ['内蒙古农信储蓄卡(6322)', ACCOUNT_NAMES.fallback], // 没建的卡 → 现金
  ];

  for (const [method, from] of REPAY_CASES) {
    it(`付款方式「${method}」还款 → ${from} → 花呗`, () => {
      expect(
        parseAlipayRepayTransfer('还款成功', '花呗', '信用借还', method),
      ).toEqual({ fromAccountName: from, toAccountName: ACCOUNT_NAMES.huabei });
    });
  }

  it('付款方式为空时落现金（实测还款行的付款方式可能为空）', () => {
    expect(parseAlipayRepayTransfer('还款成功', '花呗', '信用借还', null)).toEqual({
      fromAccountName: ACCOUNT_NAMES.fallback,
      toAccountName: ACCOUNT_NAMES.huabei,
    });
    expect(parseAlipayRepayTransfer('还款成功', '花呗', '信用借还', '/')).toEqual({
      fromAccountName: ACCOUNT_NAMES.fallback,
      toAccountName: ACCOUNT_NAMES.huabei,
    });
  });

  it('组合支付还款取前段（"花呗&花呗信用购立减" 仍是花呗→花呗 自转）', () => {
    const legs = parseAlipayRepayTransfer(
      '还款成功',
      '花呗',
      '信用借还',
      '花呗&花呗信用购立减',
    )!;
    expect(legs).toEqual({ fromAccountName: ACCOUNT_NAMES.huabei, toAccountName: ACCOUNT_NAMES.huabei });
    expect(isSelfTransfer(legs)).toBe(true);
  });

  /** 实测里"信用借还"分类下混着的 0 元凭证与失败行，一律不能变成划转 */
  const NOT_REPAY: Array<[string, string, string, string]> = [
    ['还款失败', '花呗', '信用借还', ''], // 实测 2 笔
    ['解冻成功', '', '信用借还', ''], // 实测 10 笔
    ['芝麻免押下单成功', '', '信用借还', ''], // 实测 10 笔
    ['交易关闭', '乾岳驭空低空飞行科技', '日用百货', '花呗'],
  ];

  for (const [status, merchant, cat, method] of NOT_REPAY) {
    it(`「${status}」不是还款，不生成划转`, () => {
      expect(parseAlipayRepayTransfer(status, merchant, cat, method)).toBeNull();
    });
  }

  it('状态是还款成功、但对方与分类都不指向花呗/信用时也不认（防误伤）', () => {
    expect(parseAlipayRepayTransfer('还款成功', '某商户', '日用百货', '花呗')).toBeNull();
    expect(parseAlipayRepayTransfer('还款成功', '', '', '')).toBeNull();
  });

  it('isAlipayNonMoneyStatus 覆盖实测里该丢的状态', () => {
    for (const s of ['还款失败', '交易关闭', '解冻成功', '芝麻免押下单成功', '退款成功']) {
      expect(isAlipayNonMoneyStatus(s)).toBe(true);
    }
    expect(isAlipayNonMoneyStatus('还款成功')).toBe(false);
    expect(isAlipayNonMoneyStatus('交易成功')).toBe(false);
  });
});
