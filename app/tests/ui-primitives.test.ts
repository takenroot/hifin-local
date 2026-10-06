/**
 * 基础组件的"渲染契约"单测
 * ---------------------------------------------------------------
 * 项目没有 jsdom / testing-library（node 环境 + 零新依赖约束），
 * 所以这里用 react-dom/server 的 renderToStaticMarkup 对**真实渲染输出**断言，
 * 而不是对源码做字符串匹配——组件真被改坏（属性删了、令牌换回旧的）就会红。
 *
 * 用 createElement 而非 JSX：vitest include 只收 *.test.ts，不去动共享的
 * vitest.config.ts，免得和并行的 agent 抢同一个文件。
 *
 * Modal 因为 createPortal 不被服务端渲染器支持，单独放在 modal-a11y.test.ts。
 */
import { describe, it, expect } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Button } from '@/components/ui/Button';
import { Switch } from '@/components/ui/Switch';
import { Input } from '@/components/ui/Input';
import { PageHeader } from '@/components/ui/PageHeader';
import { ProgressBar } from '@/components/ui/ProgressBar';
import { Field } from '@/components/ui/Field';

const html = (el: ReactElement) => renderToStaticMarkup(el);

describe('Button', () => {
  it('primary 用品牌靛蓝，不再是近黑 bg-text', () => {
    const out = html(h(Button, null, '保存'));
    expect(out).toContain('bg-brand');
    expect(out).toContain('text-white');
    // 近黑底色彻底退场，否则视觉上还是"黑按钮"
    expect(out).not.toMatch(/(^|\s)bg-text(\s|$)/);
  });

  it('primary 不含裸 border（accept 的 design-consistency 闸靠 border 区分 secondary）', () => {
    expect(html(h(Button, null, '保存'))).not.toMatch(/(^|\s)border(\s|$)/);
  });

  it('非 primary 变体不受品牌改色影响', () => {
    expect(html(h(Button, { variant: 'secondary' }, '取消'))).toContain('bg-bg-card');
    expect(html(h(Button, { variant: 'ghost' }, '取消'))).not.toContain('bg-brand');
  });

  it('按压反馈走 motion-safe，reduced-motion 用户拿不到缩放', () => {
    // 2026-10-06 bento-motion §4：scale 值由 0.97 改为 0.98——一档差更轻，
    // 配合 120ms --dur-press 防止"按下去又弹回"的颤动（Emil Kowalski：
    // UI 动画 ≤ 300ms，press 类 100~160ms）。
    expect(html(h(Button, null, '保存'))).toContain('motion-safe:active:scale-[0.98]');
  });

  it('press 用 --dur-press=120ms（设计 §4），覆盖 Tailwind transition 默认 150ms', () => {
    const out = html(h(Button, null, '保存'));
    expect(out).toContain('transition-duration:var(--dur-press)');
  });

  it('透传原生属性与自定义 class', () => {
    const out = html(
      h(Button, { type: 'submit', disabled: true, className: 'mt-2' }, '提交'),
    );
    expect(out).toContain('type="submit"');
    expect(out).toContain('disabled');
    expect(out).toContain('mt-2');
  });
});

describe('Switch', () => {
  it('开启态用 bg-brand，暗黑下不再与卡片同色（原先 ~1.09:1）', () => {
    const on = html(h(Switch, { checked: true, onChange: () => {} }));
    expect(on).toContain('bg-brand');
    expect(on).not.toMatch(/dark:bg-bg-card/);
  });

  it('关闭态保持 border 灰底', () => {
    expect(html(h(Switch, { checked: false, onChange: () => {} }))).toContain('bg-border');
  });

  it('role/aria-checked 跟随 checked', () => {
    const on = html(h(Switch, { checked: true, onChange: () => {} }));
    const off = html(h(Switch, { checked: false, onChange: () => {} }));
    expect(on).toContain('role="switch"');
    expect(on).toContain('aria-checked="true"');
    expect(off).toContain('aria-checked="false"');
  });

  it('透传 aria-label / aria-labelledby，禁用态带 disabled', () => {
    expect(html(h(Switch, { checked: true, onChange: () => {}, 'aria-label': '计入资产' }))).toContain(
      'aria-label="计入资产"',
    );
    expect(
      html(h(Switch, { checked: true, onChange: () => {}, 'aria-labelledby': 'row-name' })),
    ).toContain('aria-labelledby="row-name"');
    expect(html(h(Switch, { checked: true, disabled: true, onChange: () => {} }))).toContain(
      'disabled',
    );
  });
});

describe('Input', () => {
  it('错误态挂 danger 令牌，不再借用 expense(绿=支出)', () => {
    const out = html(h(Input, { invalid: true }));
    expect(out).toContain('border-danger');
    expect(out).toContain('ring-danger/30');
    expect(out).not.toContain('border-expense');
  });

  it('非错误态不带 danger', () => {
    expect(html(h(Input, null))).not.toContain('border-danger');
  });

  it('id 落到真实 input 元素上（Field 的 htmlFor 靠它关联）', () => {
    expect(html(h(Input, { id: 'goal-name' }))).toContain('id="goal-name"');
  });
});

describe('PageHeader', () => {
  it('默认标题是 h1', () => {
    expect(html(h(PageHeader, { title: '设置' }))).toMatch(/<h1[^>]*>设置<\/h1>/);
  });

  it('titleLevel="h2" 输出 h2，"div" 退回纯视觉标题', () => {
    expect(html(h(PageHeader, { title: '子标题', titleLevel: 'h2' }))).toMatch(
      /<h2[^>]*>子标题<\/h2>/,
    );
    const asDiv = html(h(PageHeader, { title: '子标题', titleLevel: 'div' }));
    expect(asDiv).not.toMatch(/<h[12]/);
    expect(asDiv).toContain('子标题');
  });
});

describe('ProgressBar', () => {
  it('宽度用 scaleX + origin-left 表达，不再直接改 width', () => {
    const out = html(h(ProgressBar, { value: 40 }));
    expect(out).toContain('scaleX(0.4)');
    expect(out).toContain('origin-left');
    // 直接改 width 会每帧触发布局
    expect(out).not.toMatch(/width:\s*40%/);
  });

  it('初值不挂 will-change（此时没有动画在跑）', () => {
    expect(html(h(ProgressBar, { value: 40 }))).not.toContain('will-change');
  });

  it('value 被夹在 0~100，越界不溢出', () => {
    expect(html(h(ProgressBar, { value: -20 }))).toContain('scaleX(0)');
    expect(html(h(ProgressBar, { value: 180 }))).toContain('scaleX(1)');
  });

  it('tone 决定颜色，showLabel 显示百分比', () => {
    expect(html(h(ProgressBar, { value: 10, tone: 'expense' }))).toContain('bg-expense');
    expect(html(h(ProgressBar, { value: 10, showLabel: true }))).toContain('10%');
  });
});

describe('Field', () => {
  it('传 htmlFor 时渲染成 <label for>，与控件 id 关联', () => {
    const out = html(
      h(Field, { label: '目标名称', htmlFor: 'goal-name', required: true }, h(Input, { id: 'goal-name' })),
    );
    expect(out).toMatch(/<label for="goal-name"/);
    expect(out).toContain('目标名称');
  });

  it('必填星号挂 danger，不占用表示"支出"的 expense 绿', () => {
    const out = html(h(Field, { label: '名称', required: true }));
    expect(out).toContain('text-danger');
    expect(out).not.toContain('text-expense');
  });

  it('非必填不画星号', () => {
    expect(html(h(Field, { label: '备注' }))).not.toContain('text-danger');
  });

  it('不传 htmlFor 时退回 div，避免指向不存在的控件', () => {
    const out = html(h(Field, { label: '标签' }));
    expect(out).not.toMatch(/<label/);
    expect(out).toContain('标签');
  });

  it('hint 渲染在右侧，labelClassName 可覆盖默认样式', () => {
    const out = html(
      h(Field, { label: '周期', hint: '可选', labelClassName: 'text-xs text-text-muted' }),
    );
    expect(out).toContain('可选');
    expect(out).toContain('text-xs');
  });

  it('label 行默认 6px 间距，调用方可覆盖（账号表单原本是 8px）', () => {
    expect(html(h(Field, { label: '目标名称' }))).toContain('mb-1.5');
    expect(html(h(Field, { label: '账户名称', className: 'mb-2' }))).toContain('mb-2');
  });
});
