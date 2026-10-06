/**
 * 「数据看板四统计卡」（zenith 形态）渲染契约
 * ---------------------------------------------------------------
 * 2026-10-06 看板重写为 zenith 形态：四卡（净资产/收入/支出/储蓄率）走白 panel
 * 卡 + 中性灰 icon chip + 大数字 + 环比 + 卡底 sparkline，**替代 2026-05 旧色块卡
 * surface.stat / 圆角 3xl / 28px 字体 / text-income 配色**。
 * 旧形态存档在 /lab/classic（ClassicLab.tsx）。
 *
 * 本测试断言新形态的渲染契约——StatCard 与 /lab/zenith 的 StatCard 是同一份契约：
 *  - 白 panel 卡（card !rounded-2xl），不再用 surface.stat
 *  - 中性灰 icon chip（bg-surface-stat 中性变体）
 *  - 大数字：text-2xl font-bold tabular-nums tracking-tight；金额语义不上色
 *  - 环比独立行（较上月 ↑X.XX% / ↓X.XX%），单次显示
 *  - 卡底 sparkline 必渲染（h-10）
 */
import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatCard } from '@/features/dashboard/Dashboard';

const html = (el: ReactElement) => renderToStaticMarkup(el);

const stat = (props: Record<string, unknown>) =>
  html(
    h(StatCard, {
      label: '本月收入',
      amount: 12800,
      deltaPct: -12.5,
      icon: '📥',
      spark: [{ value: 1 }, { value: 2 }, { value: 3 }],
      tone: 'income',
      hide: false,
      ...props,
    }),
  );

describe('数据看板四统计卡（zenith 形态）', () => {
  it('白 panel 卡（card !rounded-2xl），不再使用 surface.stat 软色底', () => {
    const out = stat({});
    expect(out).toContain('card');
    expect(out).toContain('!rounded-2xl');
    expect(out).not.toContain('bg-surface-stat-income');
    expect(out).not.toContain('bg-surface-stat-expense');
  });

  it('中性灰 icon chip：bg-surface-stat（中性变体），无方向收入色', () => {
    const out = stat({});
    expect(out).toContain('bg-surface-stat');
    expect(out).toContain('text-text-muted');
    // icon chip 不带 text-income / text-expense 上色
    expect(out).not.toMatch(/<span[^>]*text-income[^>]*>/);
  });

  it('大数字：text-2xl font-bold tabular-nums tracking-tight；金额不按方向上色', () => {
    const out = stat({});
    expect(out).toMatch(/text-2xl[^"]*font-bold[^"]*tabular-nums/);
    expect(out).toMatch(/tracking-tight/);
    // 金额本体的 text-text（中性白/黑），不上 text-income / text-expense
    expect(out).toMatch(/text-text dark:text-text-dark[^"]*">¥/);
  });

  it('环比独立行：较上月 + ↑/↓ + 百分比，绝对值显示（与 zenith 一致）', () => {
    const out = stat({});
    expect(out).toContain('较上月');
    expect(out).toMatch(/↓ 12\.50%/);
    // 支出场景 invert=true：deltaPct 为负 → good=true → 显示绿字 text-income
    const invertOut = stat({ invert: true });
    expect(invertOut).toContain('text-income');
  });

  it('卡底 sparkline 必渲染（h-10 -mx-1 mt-3）', () => {
    const out = stat({});
    expect(out).toContain('h-10 -mx-1 mt-3');
    // recharts ResponsiveContainer 占位（client 渲染不展开）
    expect(out).toContain('recharts-responsive-container');
  });

  it('卡片内只有一条「较上月」行（无重复徽章），且不出现旧 rounded-md 徽章', () => {
    const out = stat({});
    const matchCount = (out.match(/较上月/g) ?? []).length;
    expect(matchCount).toBe(1);
    expect(out).not.toContain('rounded-md whitespace-nowrap');
  });

  it('隐藏金额开关开启时显示星号占位（¥ ******）', () => {
    const out = stat({ hide: true });
    expect(out).toContain('¥ ******');
  });

  it('品牌色（净资产）卡用中性 brand tone，金额不上方向色', () => {
    const out = stat({ label: '净资产', tone: 'brand', amount: 37593.25, deltaPct: -1.47 });
    expect(out).toContain('净资产');
    // 净资产按涨跌方向自动：delta<0 → good=false → text-expense（红/坏）
    expect(out).toContain('text-expense');
    // 金额主体仍走中性 text-text
    expect(out).toMatch(/text-text dark:text-text-dark[^"]*">¥ 37,593\.25/);
  });
});