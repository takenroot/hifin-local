import { describe, it, expect } from 'vitest';
import {
  AMOUNT_MIN,
  AMOUNT_MAX,
  validateAnnualIncome,
  formatAnnualIncome,
  accountYieldDisplay,
  yieldInputValue,
} from '@/features/accounts/yield';

const THIS_YEAR = 2026;

describe('validateAnnualIncome —— 年度收益金额是选填字段', () => {
  it('留空合法：提交时不写 yield（而不是 PUT 0）', () => {
    for (const input of ['', '   ']) {
      const r = validateAnnualIncome(input);
      expect(r.ok).toBe(true);
      expect(r.empty).toBe(true);
      expect(r.value).toBeNull();
      expect(r.error).toBeNull();
    }
  });

  it('合法值透传为提交用数值', () => {
    expect(validateAnnualIncome('350')).toEqual({
      ok: true,
      value: 350,
      empty: false,
      error: null,
    });
    // 带小数（零钱通实际到账常见 350.27）同样透传
    expect(validateAnnualIncome('350.27').value).toBe(350.27);
    // 边界：0 与区间两端都合法（闭区间）
    expect(validateAnnualIncome('0').value).toBe(0);
    expect(validateAnnualIncome(String(AMOUNT_MIN)).ok).toBe(true);
    expect(validateAnnualIncome(String(AMOUNT_MAX)).ok).toBe(true);
  });

  it('范围校验：亏损合法（负收益），越界被拦下并给出中文原因', () => {
    // 投资可能亏损：负收益金额合法（如 -120.5 元）
    expect(validateAnnualIncome('-120.5').value).toBe(-120.5);
    expect(validateAnnualIncome('-1').value).toBe(-1);
    expect(validateAnnualIncome(String(AMOUNT_MIN)).ok).toBe(true);

    const tooLow = validateAnnualIncome(String(AMOUNT_MIN - 1));
    expect(tooLow.ok).toBe(false);
    expect(tooLow.error).toBe(`年度收益不能小于 ${AMOUNT_MIN}`);

    const big = validateAnnualIncome(String(AMOUNT_MAX + 1));
    expect(big.ok).toBe(false);
    expect(big.error).toBe(`年度收益不能大于 ${AMOUNT_MAX}`);

    expect(validateAnnualIncome('1000000000').ok).toBe(false);
  });

  it('非数字被拦下：不会像 parseAmount 那样兜底成 0', () => {
    for (const input of ['abc', '350 元', 'NaN', '--', '3,5x']) {
      const r = validateAnnualIncome(input);
      expect(r.ok, `期望拦截 ${input}`).toBe(false);
      expect(r.value, `期望 ${input} 不产出数值`).toBeNull();
      expect(r.error).toContain('请输入');
    }
  });

  it('容忍千分位与空格：粘贴过来的 "3, 50" 也能正确解析成 350', () => {
    expect(validateAnnualIncome(' 3, 50 ').value).toBe(350);
    // "能解析"与"在范围内"是两件事：9999999999 解析后应被范围校验拦下
    const parsed = validateAnnualIncome('9,999,999,999');
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe(`年度收益不能大于 ${AMOUNT_MAX}`);
  });
});

describe('formatAnnualIncome —— 金额展示', () => {
  it('固定两位小数 + 千分位', () => {
    expect(formatAnnualIncome(350)).toBe('350.00');
    expect(formatAnnualIncome(350.2)).toBe('350.20');
    expect(formatAnnualIncome(0)).toBe('0.00');
    expect(formatAnnualIncome(1234567.5)).toBe('1,234,567.50');
  });

  it('负收益带负号', () => {
    expect(formatAnnualIncome(-120.5)).toBe('-120.50');
    expect(formatAnnualIncome(-999999999)).toBe('-999,999,999.00');
  });

  it('非有限数兜底成 0.00，不把 NaN 印到界面上', () => {
    expect(formatAnnualIncome(NaN)).toBe('0.00');
    expect(formatAnnualIncome(Infinity)).toBe('0.00');
  });
});

describe('accountYieldDisplay —— 卡片上的展示口径', () => {
  const base = { type: 'fund' as const };

  it('有收益记录：展示「2025 年收益 ¥350.00」', () => {
    const d = accountYieldDisplay({
      ...base,
      latestYield: { year: 2025, annualIncome: 350 },
    });
    expect(d).not.toBeNull();
    expect(d!.fullText).toBe('2025 年收益 ¥350.00');
    expect(d!.year).toBe(2025);
    expect(d!.amount).toBe(350);
    expect(d!.positive).toBe(true);
  });

  it('不再有任何"预计年收益"：余额与收益无关，负余额也照常展示', () => {
    const d = accountYieldDisplay({
      type: 'fund',
      latestYield: { year: 2025, annualIncome: 350 },
    });
    expect(d!.fullText).toBe('2025 年收益 ¥350.00');
    expect(d!.fullText).not.toContain('预计');
    expect(d!.fullText).not.toContain('%');
  });

  it('负收益带负号，并标记为"不好"（配色走绿）', () => {
    const d = accountYieldDisplay({
      ...base,
      latestYield: { year: 2025, annualIncome: -120.5 },
    });
    expect(d!.fullText).toBe('2025 年收益 ¥-120.50');
    expect(d!.positive).toBe(false);
  });

  it('当年收益为 0 算"没亏没赚"，按中性偏正处理', () => {
    const d = accountYieldDisplay({ ...base, latestYield: { year: 2025, annualIncome: 0 } });
    expect(d!.fullText).toBe('2025 年收益 ¥0.00');
    expect(d!.positive).toBe(true);
  });

  it('负债账户（花呗 credit / debt）恒不展示该字段', () => {
    for (const type of ['credit', 'debt'] as const) {
      const d = accountYieldDisplay({
        type,
        latestYield: { year: THIS_YEAR, annualIncome: 350 },
      });
      expect(d, `${type} 不应展示年度收益`).toBeNull();
    }
  });

  it('core 未上线 latestYield 时容错为不展示', () => {
    expect(accountYieldDisplay({ ...base, latestYield: null })).toBeNull();
    expect(accountYieldDisplay({ ...base })).toBeNull(); // 字段整体缺失
    // 脏数据：NaN / 非数字金额一律不展示，不把 NaN 印到界面上
    expect(
      accountYieldDisplay({
        ...base,
        latestYield: { year: THIS_YEAR, annualIncome: NaN },
      }),
    ).toBeNull();
    expect(
      accountYieldDisplay({
        ...base,
        latestYield: { year: THIS_YEAR, annualIncome: 'abc' as unknown as number },
      }),
    ).toBeNull();
  });
});

describe('yieldInputValue —— 编辑时回填当前年', () => {
  it('同一年才回填', () => {
    expect(yieldInputValue({ year: THIS_YEAR, annualIncome: 350 }, THIS_YEAR)).toBe('350');
    expect(yieldInputValue({ year: THIS_YEAR, annualIncome: -120.5 }, THIS_YEAR)).toBe('-120.5');
  });

  it('往年记录不回填：输入框留空，避免把去年的收益写成今年', () => {
    expect(yieldInputValue({ year: THIS_YEAR - 1, annualIncome: 350 }, THIS_YEAR)).toBe('');
  });

  it('缺数据 / 脏数据一律回填空串', () => {
    expect(yieldInputValue(null, THIS_YEAR)).toBe('');
    expect(yieldInputValue(undefined, THIS_YEAR)).toBe('');
    expect(yieldInputValue({ year: THIS_YEAR, annualIncome: NaN }, THIS_YEAR)).toBe('');
  });
});
