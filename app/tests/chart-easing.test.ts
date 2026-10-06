/**
 * 三阶段图表缓动单测：端点/单调/段值钉死（改分段节点必须同步改这里）
 */
import { describe, it, expect } from 'vitest';
import { threePhaseEasing, THREE_PHASE_KNOTS } from '@/lib/chartEasing';

describe('threePhaseEasing', () => {
  it('端点：0→0，1→1（recharts 动画完整性前提）', () => {
    expect(threePhaseEasing(0)).toBe(0);
    expect(threePhaseEasing(1)).toBe(1);
  });

  it('段节点精确落点', () => {
    const { fastEnd, fastValue, midEnd, midValue } = THREE_PHASE_KNOTS;
    expect(threePhaseEasing(fastEnd)).toBeCloseTo(fastValue, 10);
    expect(threePhaseEasing(midEnd)).toBeCloseTo(midValue, 10);
  });

  it('全程单调不减（动画不倒退）', () => {
    let prev = 0;
    for (let i = 0; i <= 100; i++) {
      const v = threePhaseEasing(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('先快：前 30% 时间完成 60% 进度（快于匀速）', () => {
    expect(threePhaseEasing(0.3)).toBeGreaterThan(0.5);
  });

  it('后慢：90% 时刻仍未完成（长尾）', () => {
    expect(threePhaseEasing(0.9)).toBeLessThan(0.97);
  });

  it('非法输入夹取（防御 NaN 扩散到动画）', () => {
    expect(threePhaseEasing(-0.5)).toBe(0);
    expect(threePhaseEasing(1.5)).toBe(1);
  });
});
