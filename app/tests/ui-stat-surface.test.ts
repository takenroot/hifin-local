/**
 * 「色块数据卡」表面分层的渲染契约（看板英雄化）
 * ---------------------------------------------------------------
 * 站内现在只有两种卡，语义登记在 tailwind `surface` 上：
 *   surface.stat  —— 软色底 / 无边框 / 圆角 3xl，金额主角化（看板三卡 + 交易合计卡）
 *   surface.panel —— 既有白卡（index.css 的 .card：圆角 2xl + 边框 + 阴影），本轮不动
 *
 * 测法同 ui-primitives.test.ts：对**真实渲染输出**断言，而不是匹配源码。
 * 有人把 stat 卡退回 `card`（白卡+边框）、把圆角改回 2xl、或把金额降回
 * text-2xl，这里都会红。
 */
import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StatCard } from '@/features/dashboard/Dashboard';
import { SumCell } from '@/features/transactions/TransactionListView';

const html = (el: ReactElement) => renderToStaticMarkup(el);

const stat = (props: Record<string, unknown>) =>
  html(h(StatCard, { label: '本月收入', icon: '📥', tone: 'income', surface: 'income', amount: 12800, delta: -12.5, ...props }));

describe('看板资产概览三卡（surface.stat）', () => {
  it('软色底按金额语义取 surface.stat.*，不再是白卡', () => {
    expect(stat({})).toContain('bg-surface-stat-income');
    expect(stat({ surface: 'expense', tone: 'expense' })).toContain('bg-surface-stat-expense');
    expect(stat({ surface: 'brand', tone: 'dynamic', primary: true })).toContain('bg-surface-stat-brand');
  });

  it('每张卡都配了暗色变体（暗色下不能退回白底）', () => {
    const out = stat({});
    expect(out).toMatch(/dark:bg-surface-stat-income-dark/);
    expect(stat({ surface: 'brand' })).toMatch(/dark:bg-surface-stat-brand-dark/);
  });

  it('无边框、圆角 3xl（白卡面板才是 2xl），也绝不出现 hover:shadow', () => {
    const out = stat({});
    expect(out).toContain('rounded-3xl');
    expect(out).not.toMatch(/(^|[\s"])(card|border)([\s"])/);
    expect(out).not.toMatch(/(^|[\s"])rounded-2xl([\s"])/);
    expect(out).not.toContain('hover:shadow');
  });

  it('背景过渡 160ms（走 --dur-surface 动效令牌），不加别的动效', () => {
    expect(stat({})).toContain(
      'transition-[background-color_var(--dur-surface)_var(--ease-out)]',
    );
  });

  it('主卡（净资产）带左侧 3px brand 边条，其余卡不带', () => {
    const primary = stat({ surface: 'brand', tone: 'dynamic', primary: true });
    expect(primary).toMatch(/before:w-\[3px\]/);
    expect(primary).toMatch(/before:bg-brand/);
    expect(primary).toMatch(/pl-6/);
    expect(stat({})).not.toContain('before:w-[3px]');
  });

  it('金额升到 28px 半粗 tabular-nums，标签降为 text-xs muted', () => {
    const out = stat({});
    expect(out).toMatch(/text-\[28px\][^"]*font-semibold[^"]*tabular-nums/);
    expect(out).toMatch(/text-xs text-text-muted dark:text-text-muted-dark/);
    expect(out).not.toMatch(/text-2xl/);
  });

  it('金额仍按金额语义上色（收入红 / 支出绿），hero 化不改配色约定', () => {
    expect(stat({})).toContain('text-income');
    expect(stat({ tone: 'expense', surface: 'expense' })).toContain('text-expense');
  });

  it('环比只出现一次：原来的徽章与「较上月」行是重复的', () => {
    const out = stat({});
    expect(out).toContain('较上月');
    expect([...out.matchAll(/-12\.50%/g)]).toHaveLength(1);
    expect(out).not.toContain('rounded-md whitespace-nowrap');
  });
});

describe('交易页合计卡（surface.stat）', () => {
  const sum = (tone: 'income' | 'expense' | 'neutral') =>
    html(h(SumCell, { tone, label: tone, value: 42639.93 }));

  it('收入/支出合计卡用方向色块，中性走无方向 stat 底', () => {
    expect(sum('income')).toContain('bg-surface-stat-income');
    expect(sum('expense')).toContain('bg-surface-stat-expense');
    expect(sum('neutral')).toContain('bg-surface-stat');
  });

  it('同样是无边框圆角色块卡 + 160ms 背景过渡', () => {
    const out = sum('income');
    expect(out).toContain('rounded-3xl');
    expect(out).toContain('transition-[background-color_var(--dur-surface)_var(--ease-out)]');
    expect(out).not.toMatch(/(^|[\s"])card([\s"])/);
    expect(out).not.toMatch(/(^|[\s"])border([\s"])/);
  });

  it('390px 下一列只有 ~171px，金额保持 text-xl，≥640px 才升 text-2xl', () => {
    const out = sum('expense');
    expect(out).toContain('text-xl sm:text-2xl');
  });
});
