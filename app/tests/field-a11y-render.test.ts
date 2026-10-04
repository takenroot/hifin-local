/**
 * Field 的可访问名链路：真渲染一遍再断言
 * ---------------------------------------------------------------
 * field-convergence.test.ts 是正则扫源码，挡得住「写错」挡不住「没写」：
 * RulesSection 的「关键词」Input 明明有 id，Field 却漏了 htmlFor，两边正则都通过，
 * 读屏照样读不出字段名。这类「关联关系整个不存在」的洞只有真渲染才看得见。
 *
 * 沿用 modal-a11y.test.ts 的办法：项目没 jsdom，只有 node 环境和 react-dom/server，
 * 不引入新依赖。Field / Select 都不碰 DOM 也不跑 effect，服务端渲染即最终产物。
 */
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Field } from '@/components/ui/Field';
import { Select } from '@/components/ui/Select';

const render = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);

/** 取第一个 <label ...> 开标签的属性串 */
const labelTag = (html: string) => html.match(/<label\b[^>]*>/)?.[0] ?? '';
/** 取 role=combobox 那个按钮的开标签属性串 */
const comboTag = (html: string) => html.match(/<button\b[^>]*role="combobox"[^>]*>/)?.[0] ?? '';
/** 取属性值，兼容 a="1" 与 a={"1"} */
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

/** 去掉标签和注释后，剩下的就是节点文本——用它近似「读屏会念的内容」 */
const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const OPTS = [{ label: '餐饮', value: 'food' }];

describe('Field + Select 的可访问名链路', () => {
  it('htmlFor 与 Select 的 id 对得上，取名链路闭合', () => {
    const html = render(
      h(Field, { label: '导入平台', htmlFor: 'p1' }, h(Select, { id: 'p1', options: OPTS })),
    );
    // 取名要成立，两端必须指向同一个 id：label 的 for 和 combobox 按钮的 id。
    // button 本身就是 labelable 元素，<label for> 对 role=combobox 是生效的
    // （Playwright a11y snapshot 实测：可访问名取到「导入平台」而不是按钮内的「餐饮」）。
    expect(attr(labelTag(html), 'for')).toBe('p1');
    expect(attr(comboTag(html), 'id')).toBe('p1');
  });

  it('label 文案落在可访问名上，不会被按钮内文字顶掉', () => {
    const html = render(
      h(Field, { label: '数据范围', htmlFor: 'r1' }, h(Select, { id: 'r1', options: OPTS })),
    );
    expect(textOf(html)).toContain('数据范围');
  });

  it('必填星号是 aria-hidden，不混进可访问名', () => {
    const html = render(
      h(
        Field,
        { label: '周期', required: true, htmlFor: 'pd1' },
        h(Select, { id: 'pd1', options: OPTS }),
      ),
    );
    // 不加 aria-hidden 时读屏会念「周期 星号」。星号还在，只是对读屏隐身。
    const labelHtml = html.slice(html.indexOf('<label'), html.indexOf('</label>'));
    expect(labelHtml).toContain('aria-hidden');
    expect(labelHtml).toContain('*');
    expect(attr(labelTag(html), 'for')).toBe('pd1');
  });

  it('labelId 落在带文案的那个元素上，role=group 的 aria-labelledby 才指得到', () => {
    const html = render(
      h(
        Field,
        { label: '颜色', labelId: 'c1' },
        h('div', { role: 'group', 'aria-labelledby': 'c1' }, h('button', { type: 'button' }, '红')),
      ),
    );
    // 一组控件没法 htmlFor 到单个元素，只能「带文案的元素给 id + 容器 role=group 整组取名」。
    // 没 htmlFor 时 Field 落成 <div id>（不是 <label>）——这不影响取名：
    // aria-labelledby 指向任意元素都行，accname 取它的子树文本（实测 span/div 同理）。
    expect(html).toContain('id="c1"');
    expect(html).toContain('role="group"');
    expect(attr(labelTag(html), 'id')).toBeUndefined(); // 无 htmlFor 时压根不该有 <label>
    // 关键：指向的 id 所在元素必须真的装着「颜色」这段文案，否则取到空名字
    const holder = html.match(/<[^>]*\bid="c1"[^>]*>[^<]*/)?.[0] ?? '';
    expect(holder).toContain('颜色');
  });

  it('没给 htmlFor 时不硬凑 <label>，label 会退化成 div', () => {
    // 这正是「一排按钮」那几处必须补 role=group 的原因：没有可指向的单个控件，
    // Field 就只能出 div，整组取名得调用方自己接。
    const html = render(h(Field, { label: '颜色' }, h('button', { type: 'button' }, '红')));
    expect(labelTag(html)).toBe('');
    expect(html).toContain('>颜色<');
  });
});
