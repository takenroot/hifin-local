/**
 * AI 财务建议卡：buildInsightContext 纯函数测试
 * 口径：只放概况级数字；预算/目标为空时不输出对应行（不编造）。
 */
import { describe, it, expect } from 'vitest';
import { buildInsightContext } from '@/features/dashboard/InsightCard';

const base = {
  netAsset: 37033.25,
  savingsRate: 33.3,
  monthly: [
    { month: '2026-09', income: 10000, expense: 5000, balance: 5000 },
    { month: '2026-10', income: 12000, expense: 8000, balance: 4000 },
  ],
  budgets: [{ name: '日常餐饮', spent: 300, amount: 2000 }],
  goals: [{ name: '应急基金', current: 18500, target: 30000 }],
};

describe('buildInsightContext', () => {
  it('含净资产/本月/12 月序列/预算/目标五行', () => {
    const text = buildInsightContext(base);
    expect(text).toContain('37033.25');
    expect(text).toContain('2026-10');
    expect(text).toContain('收10000/支5000');
    expect(text).toContain('日常餐饮 已花 300.00/2000.00');
    expect(text).toContain('应急基金 18500.00/30000.00');
  });

  it('预算/目标为空时不输出对应行（不编造）', () => {
    const text = buildInsightContext({ ...base, budgets: [], goals: [] });
    expect(text).not.toContain('预算执行');
    expect(text).not.toContain('目标进度');
    // 基础三行仍在
    expect(text).toContain('当前净资产');
  });

  it('多预算多目标全部列出', () => {
    const text = buildInsightContext({
      ...base,
      budgets: [
        { name: 'A', spent: 1, amount: 2 },
        { name: 'B', spent: 3, amount: 4 },
      ],
    });
    expect(text).toContain('A 已花 1.00/2.00；B 已花 3.00/4.00');
  });
});
