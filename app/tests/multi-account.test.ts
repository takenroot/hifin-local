/**
 * 多账户相关的纯逻辑测试
 * -----------------------------------------------------------------
 * app 侧的用例全是纯计算测试（没有 jsdom / testing-library），所以 UI 上
 * 真正新增的判断都先抽成纯函数（accountBalanceDisplay / buildDistribution），
 * 再在这里钉住。覆盖：
 *   1. 账户列表：负债账户余额恒红 + 取绝对值 + isDebtType 判定
 *   2. 资产分布：多账户下的分组、占比，以及"画不进饼图的负值/负债"对账
 *
 * 账户数据照抄本次多账户设计（7 个账户），余额取自实测账单导入后的形状：
 * 工行卡被花呗还款扣成负数、花呗收下还款后余额为正——正是会让饼图对不上账
 * 的那两种情况。
 */

import { describe, it, expect } from 'vitest';
import type { Account } from '@/db';
import {
  accountBalanceDisplay,
  balanceToneClass,
  debtBalanceToneClass,
  isDebtType,
} from '@/features/accounts/format';
import {
  buildDistribution,
  calcNetAsset,
  distributionByAccount,
  distributionByAccountType,
  isDebtAccount,
} from '@/features/dashboard/calculations';

function acc(over: Partial<Account>): Account {
  return {
    id: 1,
    name: '测试账户',
    type: 'fund',
    balance: 0,
    includeInNetAsset: true,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** 7 个账户，形状照抄实测：工行卡被还款扣成负数、花呗收下还款为正 */
const SEVEN: Account[] = [
  acc({ id: 1, name: '零钱通', type: 'invest', balance: 1000 }),
  acc({ id: 2, name: '余额宝', type: 'invest', balance: 2000 }),
  acc({ id: 3, name: '工行卡(1230)', type: 'fund', balance: -2450.4 }),
  acc({ id: 4, name: '中行卡(3544)', type: 'fund', balance: 500 }),
  acc({ id: 5, name: '建行卡(9151)', type: 'fund', balance: 300 }),
  acc({ id: 6, name: '花呗', type: 'credit', balance: 3075.35 }),
  acc({ id: 7, name: '现金', type: 'fund', balance: 120 }),
];

// ══════════════════════════════════════════════════════════════
describe('账户列表：负债账户恒红 + 取绝对值', () => {
  it('负债账户余额为负时仍显红色（不是绿色）', () => {
    const d = accountBalanceDisplay(-300, 'credit');
    expect(d.isDebt).toBe(true);
    expect(d.toneClass).toBe(debtBalanceToneClass());
    expect(d.toneClass).not.toBe(balanceToneClass(-300)); // 不能是"欠钱=绿"
  });

  it('负债账户余额为正（还清后的可用额度）时也是红色', () => {
    const d = accountBalanceDisplay(3075.35, 'credit');
    expect(d.toneClass).toBe(debtBalanceToneClass());
    expect(d.isDebt).toBe(true);
  });

  it('负债账户一律展示绝对值，不显示负号', () => {
    expect(accountBalanceDisplay(-300, 'credit').text).toBe('¥ 300.00');
    expect(accountBalanceDisplay(300, 'debt').text).toBe('¥ 300.00');
  });

  it('资产账户行为不变：按正负着色、原样带符号', () => {
    expect(accountBalanceDisplay(1000, 'fund').isDebt).toBe(false);
    expect(accountBalanceDisplay(1000, 'fund').toneClass).toBe(balanceToneClass(1000));
    expect(accountBalanceDisplay(-1000, 'fund').toneClass).toBe(balanceToneClass(-1000));
    expect(accountBalanceDisplay(-1000, 'fund').text).toBe('¥ -1,000.00');
  });

  it('资产账户的 7 种 type 都不算负债', () => {
    for (const t of ['fund', 'asset', 'social', 'invest', 'other']) {
      expect(isDebtType(t)).toBe(false);
      expect(accountBalanceDisplay(100, t).isDebt).toBe(false);
    }
    for (const t of ['credit', 'debt']) {
      expect(isDebtType(t)).toBe(true);
    }
  });

  it('余额为 0 的负债账户也是红色（否则一排"灰 0"会看不出是欠的还是没记）', () => {
    expect(accountBalanceDisplay(0, 'credit').toneClass).toBe(debtBalanceToneClass());
  });
});

// ══════════════════════════════════════════════════════════════
describe('资产分布：多账户下按账户分组', () => {
  it('7 个账户里只有正余额的资产账户进饼图', () => {
    const items = distributionByAccount(SEVEN);
    expect(items.map((i) => i.name)).toEqual(['零钱通', '余额宝', '中行卡(3544)', '建行卡(9151)', '现金']);
    // 负余额的工行卡、负债花呗都不在饼图里（饼图画不了负数）
    expect(items.find((i) => i.name === '工行卡(1230)')).toBeUndefined();
    expect(items.find((i) => i.name === '花呗')).toBeUndefined();
  });

  it('7 个账户会自然出图（不是只有单账户时才出图）', () => {
    expect(distributionByAccount(SEVEN).length).toBeGreaterThan(1);
  });

  it('不计入净资产的账户不进饼图', () => {
    const items = distributionByAccount([acc({ name: '隐藏账户', balance: 999, includeInNetAsset: false })]);
    expect(items).toHaveLength(0);
  });

  it('余额为 0 的账户不进饼图（0 份额画出来是条看不见的缝）', () => {
    expect(distributionByAccount([acc({ name: '零余额', balance: 0 })])).toHaveLength(0);
  });
});

describe('资产分布：按交易方式分组', () => {
  it('invest 聚成"投资"、fund 聚成"资金"、credit 单独排除', () => {
    const items = distributionByAccountType(SEVEN);
    const byName = Object.fromEntries(items.map((i) => [i.name, i.value]));
    expect(byName['投资']).toBe(3000); // 零钱通 1000 + 余额宝 2000
    expect(byName['资金']).toBe(920); // 中行 500 + 建行 300 + 现金 120（工行是负数，不计）
    expect(byName['信用']).toBeUndefined();
  });

  it('按类型分组时负余额的工行卡也不进"资金"', () => {
    const items = distributionByAccountType(SEVEN);
    expect(items.find((i) => i.name === '资金')!.value).toBe(920);
  });
});

describe('资产分布：对账——画不进饼图的钱要被报出来', () => {
  it('负余额资产账户的合计被单独报出（多账户后最常见的"对不上账"来源）', () => {
    const d = buildDistribution(SEVEN, 'account');
    expect(d.excludedNegative).toBeCloseTo(-2450.4, 6);
    expect(d.excludedDebt).toBeCloseTo(3075.35, 6);
  });

  it('饼图数据与老函数逐项一致（换函数不改变图形）', () => {
    const d = buildDistribution(SEVEN, 'account');
    expect(d.items).toEqual(distributionByAccount(SEVEN));
    const t = buildDistribution(SEVEN, 'type');
    expect(t.items).toEqual(distributionByAccountType(SEVEN));
  });

  it('所有账户都是正数时，两项对账都为 0（不显示多余的说明）', () => {
    const d = buildDistribution(
      [acc({ name: 'A', balance: 100 }), acc({ name: 'B', balance: 200 })],
      'account',
    );
    expect(d.excludedNegative).toBe(0);
    expect(d.excludedDebt).toBe(0);
  });

  it('没有负债账户时 excludedDebt 为 0（别显示"负债合计 ¥0.00"）', () => {
    const d = buildDistribution([acc({ name: 'A', balance: 100 })], 'account');
    expect(d.excludedDebt).toBe(0);
  });

  it('不计入净资产的负余额账户不参与对账（它压根不在净资产里）', () => {
    const d = buildDistribution(
      [acc({ name: 'A', balance: 100 }), acc({ name: '隐藏', balance: -50, includeInNetAsset: false })],
      'account',
    );
    expect(d.excludedNegative).toBe(0);
  });

  it('全部资产账户都是负数时饼图为空，但负值仍被报出来（不是静默"暂无数据"）', () => {
    const d = buildDistribution([acc({ name: 'A', balance: -100 })], 'account');
    expect(d.items).toHaveLength(0);
    expect(d.excludedNegative).toBeCloseTo(-100, 6);
  });

  it('饼图合计 + 负值 = 资产合计，资产合计 - 负债 = 净资产（两步都对得上账）', () => {
    const d = buildDistribution(SEVEN, 'account');
    const pieSum = d.items.reduce((s, i) => s + i.value, 0);
    // 与看板净资产同一口径：资产类余额求和 - 负债类余额绝对值求和
    const assets = SEVEN.filter((a) => !isDebtAccount(a)).reduce((s, a) => s + a.balance, 0);
    const debts = SEVEN.filter(isDebtAccount).reduce((s, a) => s + Math.abs(a.balance), 0);

    // 第一步：饼图 + 被排除的负值 = 全部资产余额（一分不差）
    expect(pieSum + d.excludedNegative).toBeCloseTo(assets, 6);
    // 第二步：资产 - 负债 = 看板上的净资产
    expect(assets - debts).toBeCloseTo(calcNetAsset(SEVEN), 6);
  });
});
