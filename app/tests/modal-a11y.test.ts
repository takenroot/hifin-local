/**
 * Modal 对话框契约单测
 * ---------------------------------------------------------------
 * Modal 有 28 个调用点，是全项目复用最狠的组件，它一坏就是 28 个弹层一起坏。
 *
 * 测法说明（踩过的坑写在这，免得后人以为这里偷懒）：
 *   - 项目没有 jsdom，只有 node 环境。createPortal 不被 renderToStaticMarkup 支持，
 *     所以把 react-dom 的 createPortal 换成恒等函数，让 Modal 的**真实代码**就地渲染，
 *     再对渲染出来的 HTML 断言 a11y 属性。
 *   - 焦点行为（初始焦点 / Tab 循环 / 关闭归还）依赖 useEffect + 真实 DOM，
 *     服务端渲染不跑 effect，因此这部分退化为对 Modal.tsx 源码的静态契约断言——
 *     至少能挡住"有人把焦点陷阱整段删掉"。
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal } from '@/components/ui/Modal';

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>();
  return { ...actual, createPortal: (node: ReactNode) => node };
});

// createPortal 被 mock 成恒等函数，但它**两个参数仍会被求值**，所以
// document.body 这个表达式在 node 环境里也得有个值。容器本身没人用，丢即可。
beforeAll(() => {
  (globalThis as { document?: unknown }).document ??= { body: {} };
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const open = (props: Partial<Parameters<typeof Modal>[0]> = {}) =>
  html(h(Modal, { open: true, onClose: () => {}, ...props }, h('input', { id: 'first' })));

describe('Modal · 对话框语义', () => {
  it('面板带 role=dialog + aria-modal=true', () => {
    const out = open();
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
  });

  it('aria-labelledby 指向 useId 生成的标题 id（两处必须同一个值）', () => {
    const out = open({ title: '新建流水' });
    const labelledBy = out.match(/aria-labelledby="([^"]+)"/)?.[1];
    expect(labelledBy).toBeTruthy();
    expect(out).toContain(`id="${labelledBy}"`);
    expect(out).toContain('新建流水');
  });

  it('无标题时退回 aria-label，不留一个指向空节点的 aria-labelledby', () => {
    const out = open();
    expect(out).not.toContain('aria-labelledby');
    expect(out).toContain('aria-label="对话框"');
  });

  it('关闭按钮有无障碍名字（图标按钮光有 svg 读屏读不出"关闭"）', () => {
    expect(open({ title: '删除' })).toContain('aria-label="关闭"');
  });

  it('hideClose 时不渲染关闭按钮', () => {
    const out = open({ title: '搜索', hideClose: true });
    expect(out).not.toContain('aria-label="关闭"');
  });

  it('open=false 时不渲染任何东西', () => {
    expect(html(h(Modal, { open: false, onClose: () => {} }))).toBe('');
  });
});

describe('Modal · DOM 形状（accept 脚本依赖，勿改）', () => {
  it('外层仍是 fixed inset-0 z-50，面板仍带 relative', () => {
    const out = open({ title: '账户详情' });
    // calendar-month-nav.mjs 用 `div.fixed.inset-0.z-50 > div.relative` 定位弹层
    expect(out).toContain('fixed inset-0 z-50');
    expect(out).toMatch(/class="[^"]*\brelative\b[^"]*"/);
  });
});

describe('Modal · 焦点管理（静态契约：需要真实 DOM 才能行为级验证）', () => {
  const src = () => readFileSync(new URL('../src/components/ui/Modal.tsx', import.meta.url), 'utf8');

  it('处理 Tab / Shift+Tab 的焦点循环', () => {
    const code = src();
    expect(code).toContain("e.key !== 'Tab'");
    expect(code).toContain('e.shiftKey');
  });

  it('打开时把焦点落到第一个可交互元素', () => {
    expect(src()).toContain('focusables(panelRef.current)[0]?.focus()');
  });

  it('关闭后把焦点还给触发元素', () => {
    const code = src();
    expect(code).toContain('document.activeElement');
    // 归还动作必须在 effect 的 cleanup 里
    expect(code).toMatch(/return \(\) => \{[^}]*prev\?\.focus\?\.\(\)/);
  });

  it('Esc 关闭仍然保留（accept 的 calendar-month-nav 靠它收起弹层）', () => {
    expect(src()).toContain("e.key === 'Escape'");
  });
});
