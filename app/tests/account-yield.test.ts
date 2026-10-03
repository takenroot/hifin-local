import { describe, it, expect } from 'vitest';
import {
  YIELD_MIN,
  YIELD_MAX,
  validateYieldInput,
  formatYieldPercent,
  estimatedAnnualYield,
  accountYieldDisplay,
  yieldInputValue,
} from '@/features/accounts/yield';

const THIS_YEAR = 2026;

describe('validateYieldInput —— 年收益率是选填字段', () => {
  it('留空合法：提交时不写 yield（而不是 PUT 0）', () => {
    for (const input of ['', '   ']) {
      const r = validateYieldInput(input);
      expect(r.ok).toBe(true);
      expect(r.empty).toBe(true);
      expect(r.value).toBeNull();
      expect(r.error).toBeNull();
    }
  });

  it('合法值透传为提交用数值', () => {
    expect(validateYieldInput('2.1')).toEqual({
      ok: true,
      value: 2.1,
      empty: false,
      error: null,
    });
    // 边界：0 与 100 都合法（闭区间）
    expect(validateYieldInput('0').value).toBe(0);
    expect(validateYieldInput('100').value).toBe(100);
    expect(validateYieldInput(String(YIELD_MIN)).ok).toBe(true);
    expect(validateYieldInput(String(YIELD_MAX)).ok).toBe(true);
  });

  it('范围校验：亏损合法（负收益），-100 以下 / 超 100 被拦下并给出中文原因', () => {
    // 投资可能亏损：负收益率合法（如 -0.42%）
    expect(validateYieldInput('-0.42').value).toBe(-0.42);
    expect(validateYieldInput('-1').value).toBe(-1);
    expect(validateYieldInput('-100').ok).toBe(true);

    const tooLow = validateYieldInput('-100.1');
    expect(tooLow.ok).toBe(false);
    expect(tooLow.error).toBe('年收益率不能小于 -100%');

    const big = validateYieldInput('101');
    expect(big.ok).toBe(false);
    expect(big.error).toBe('年收益率不能大于 100%');

    expect(validateYieldInput('100.1').ok).toBe(false);
  });

  it('非数字被拦下：不会像 parseAmount 那样兜底成 0', () => {
    for (const input of ['abc', '2.1%', 'NaN', '--', '1,2x']) {
      const r = validateYieldInput(input);
      expect(r.ok, `期望拦截 ${input}`).toBe(false);
      expect(r.value, `期望 ${input} 不产出数值`).toBeNull();
      expect(r.error).toContain('请输入');
    }
  });

  it('容忍千分位与空格：粘贴过来的 "2, 1" 也能正确解析成 21', () => {
    expect(validateYieldInput(' 2, 1 ').value).toBe(21);
    // "能解析"与"在范围内"是两件事：2,100 解析成 2100，应被范围校验拦下
    const parsed = validateYieldInput('2,100');
    expect(parsed.error).toBe('年收益率不能大于 100%');
  });
});

describe('formatYieldPercent / estimatedAnnualYield', () => {
  it('百分比去掉无意义的小数尾零', () => {
    expect(formatYieldPercent(2)).toBe('2');
    expect(formatYieldPercent(2.1)).toBe('2.1');
    expect(formatYieldPercent(2.10)).toBe('2.1');
    expect(formatYieldPercent(0.5)).toBe('0.5');
  });

  it('浮点误差被收敛，不会显示 2.1000000000000005 这种', () => {
    expect(formatYieldPercent(0.1 + 0.2)).toBe('0.3');
  });

  it('预计年收益 = 当前余额 × 收益率', () => {
    expect(estimatedAnnualYield(10000, 2.1)).toBeCloseTo(210, 6);
    expect(estimatedAnnualYield(0, 5)).toBe(0);
  });
});

describe('accountYieldDisplay —— 卡片上的展示口径', () => {
  const base = { type: 'fund' as const, balance: 10000 };

  it('有收益率 + 正余额：百分比与预计年收益同行展示', () => {
    const d = accountYieldDisplay({
      ...base,
      latestYield: { year: THIS_YEAR, yieldPercent: 2.1 },
    });
    expect(d).not.toBeNull();
    expect(d!.percentText).toBe('年收益率 2.1%');
    expect(d!.estimateText).toBe('预计年收益 ¥ 210.00');
    expect(d!.fullText).toBe('年收益率 2.1% · 预计年收益 ¥ 210.00');
  });

  it('负余额：只显示百分比，不显示预计（乘出来是负收益）', () => {
    const d = accountYieldDisplay({
      type: 'fund',
      balance: -36089.78,
      latestYield: { year: THIS_YEAR, yieldPercent: 2.1 },
    });
    expect(d!.percentText).toBe('年收益率 2.1%');
    expect(d!.estimateText).toBeNull();
    expect(d!.fullText).toBe('年收益率 2.1%');
  });

  it('零余额同样不给"预计 ¥ 0.00"这种无信息量的行', () => {
    const d = accountYieldDisplay({
      ...base,
      balance: 0,
      latestYield: { year: THIS_YEAR, yieldPercent: 3 },
    });
    expect(d!.estimateText).toBeNull();
    expect(d!.fullText).toBe('年收益率 3%');
  });

  it('负债账户（花呗 credit / debt）恒不展示该字段', () => {
    for (const type of ['credit', 'debt'] as const) {
      const d = accountYieldDisplay({
        type,
        balance: 139.29,
        latestYield: { year: THIS_YEAR, yieldPercent: 2.1 },
      });
      expect(d, `${type} 不应展示年收益率`).toBeNull();
    }
  });

  it('core 未上线 latestYield 时容错为不展示', () => {
    expect(accountYieldDisplay({ ...base, latestYield: null })).toBeNull();
    expect(accountYieldDisplay({ ...base })).toBeNull(); // 字段整体缺失
    // 脏数据：NaN / 非数字百分比一律不展示，不把 NaN 印到界面上
    expect(
      accountYieldDisplay({
        ...base,
        latestYield: { year: THIS_YEAR, yieldPercent: NaN },
      }),
    ).toBeNull();
    expect(
      accountYieldDisplay({
        ...base,
        latestYield: { year: THIS_YEAR, yieldPercent: 'abc' as unknown as number },
      }),
    ).toBeNull();
  });
});

describe('yieldInputValue —— 编辑时回填当前年', () => {
  it('同一年才回填', () => {
    expect(yieldInputValue({ year: THIS_YEAR, yieldPercent: 2.1 }, THIS_YEAR)).toBe('2.1');
  });

  it('往年记录不回填：输入框留空，避免把去年的时间写成今年', () => {
    expect(yieldInputValue({ year: THIS_YEAR - 1, yieldPercent: 2.1 }, THIS_YEAR)).toBe('');
  });

  it('缺数据 / 脏数据一律回填空串', () => {
    expect(yieldInputValue(null, THIS_YEAR)).toBe('');
    expect(yieldInputValue(undefined, THIS_YEAR)).toBe('');
    expect(yieldInputValue({ year: THIS_YEAR, yieldPercent: NaN }, THIS_YEAR)).toBe('');
  });
});
