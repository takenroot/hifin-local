/**
 * Field 收敛的完整性检查
 * ---------------------------------------------------------------
 * Field 的 htmlFor 和控件的 id 是两处手写字符串，打错一个字不会报 TS 错，
 * 只会让 <label for> 悄悄指空——读屏照样读不出字段名，属于"测试全绿但没修好"。
 * 这个文件把整棵 features/ 扫一遍，把这类静默失配挡在 CI 之外。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src/', import.meta.url).pathname;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile() && /\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

// 只扫 src/：把 tests/ 也扫进来会让自己文件里的正则字面量（"<label"、"<Switch"）自匹配
const files = walk(SRC);
// 断言的是标记，不是散文：源码注释里常出现 "<label htmlFor>" 这类字样（Field/Select/Switch
// 的 JSDoc、各处解释为何这么写的行内注释），不剥掉会一堆假阳性。块注释足够覆盖这些场景，
// 行注释不剥——那会误伤字符串里的 "https://"。
const sources = new Map(
  files.map((f) => [f, readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')]),
);
const matchAll = (code: string, re: RegExp) => Array.from(code.matchAll(re), (m) => m[1]);

describe('Field 收敛', () => {
  it('components/ui/Field.tsx 是唯一定义，features 下没有残留副本', () => {
    const copies = [...sources.entries()]
      .filter(([f, code]) => /function Field\s*\(/.test(code))
      .map(([f]) => f.replace(SRC, 'src/'));
    expect(copies).toEqual(['src/components/ui/Field.tsx']);
  });

  it('每个 Field 的 htmlFor 在同一文件里都有同名 id 的控件', () => {
    const orphans: string[] = [];
    for (const [file, code] of sources) {
      const ids = new Set([
        ...matchAll(code, /\bid="([^"]+)"/g),
        ...matchAll(code, /\bid=\{`([^`$]+)`\}/g),
      ]);
      for (const target of matchAll(code, /htmlFor="([^"]+)"/g)) {
        if (!ids.has(target)) orphans.push(`${file.replace(SRC, 'src/')} -> ${target}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it('收敛的 5 个表单里不再手写 <label>，label 统一由共享 Field 产出', () => {
    // 全仓扫 <label> 见下面「裸 label 残留」一节：这里只守住自己改过的表单，防止有人又抄一份回去。
    const CONVERGED = [
      'features/transactions/TransactionFormModal.tsx',
      'features/goals/GoalFormModal.tsx',
      'features/accounts/AccountFormModal.tsx',
      'features/budget/BudgetFormModal.tsx',
      'features/settings/sections/AiSection.tsx',
    ];
    const offenders = CONVERGED.filter((rel) =>
      sources.has(join(SRC, rel)) ? /<label[\s>]/.test(sources.get(join(SRC, rel))!) : true,
    );
    expect(offenders).toEqual([]);
  });
});

describe('裸 label 残留', () => {
  it('src/ 下每个手写 <label> 都带 htmlFor', () => {
    // [^>]* 会跨行，所以 NotificationCenter 那种 htmlFor 换行写在下一行的也算数。
    // Field.tsx 的 <label htmlFor={htmlFor}> 是动态属性，天然带 `htmlFor=`，同样算数。
    const bare: string[] = [];
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/<label\b([^>]*)>/g)) {
        if (!/\bhtmlFor\s*=/.test(m[1])) {
          const line = code.slice(0, m.index).split('\n').length;
          bare.push(`${file.replace(SRC, 'src/')}:${line}`);
        }
      }
    }
    expect(bare).toEqual([]);
  });

  it('控件组的 role=group 都用 aria-labelledby 指向一个真实 id', () => {
    // 颜色/图标/展示组件是一排按钮，label 只能 htmlFor 到单个 labelable 元素，
    // 只能整组取名。指向不存在的 id 等于没取名，所以这里核对 id 真实存在。
    const dangling: string[] = [];
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/aria-labelledby=\{`([^`]+)`\}/g)) {
        // 模板串里的 ${uid} 之类按字面找会失配，转成「去掉插值的字面量」再找
        const literal = m[1].replace(/\$\{[^}]+\}/g, '');
        const hasId =
          new RegExp('\\bid="[^"]*' + literal + '"').test(code) ||
          new RegExp('\\bid=\\{`[^`]*' + literal).test(code) ||
          // Field 的 labelId prop：label 自身的 id 也算真实 id
          new RegExp('\\blabelId=\\{`[^`]*' + literal).test(code);
        if (!hasId) dangling.push(`${file.replace(SRC, 'src/')} -> ${m[1]}`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('每个 role=group 都带 aria-labelledby', () => {
    // 上面那条只查「aria-labelledby 指向的 id 真实存在」，是单向的：
    // 有人新加一个 role=group 却忘了取名，那条照样全绿。这里补反向——组必须有名字。
    const nameless: string[] = [];
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/<(\w+)\b([^>]*\brole="group"[^>]*)>/g)) {
        if (!/\baria-labelledby\s*=/.test(m[2])) {
          nameless.push(
            `${file.replace(SRC, 'src/')}:${code.slice(0, m.index).split('\n').length} <${m[1]}>`,
          );
        }
      }
    }
    expect(nameless).toEqual([]);
  });

  it('Field 的 labelId 总有一对 role=group + aria-labelledby 去消费它', () => {
    // labelId 是给「一排按钮」用的：Field 把 id 挂在带文案的元素上，
    // 靠子容器的 role=group 整组取名。只写 labelId 不接 group 等于白写。
    const halfWired: string[] = [];
    for (const [file, code] of sources) {
      for (const m of code.matchAll(/\blabelId=\{`([^`]+)`\}/g)) {
        const literal = m[1].replace(/\$\{[^}]+\}/g, '');
        if (!new RegExp('aria-labelledby=\\{`[^`]*' + literal).test(code)) {
          halfWired.push(`${file.replace(SRC, 'src/')} -> ${m[1]}`);
        }
      }
    }
    expect(halfWired).toEqual([]);
  });

  it('必填星号走 required prop，不在 label 文案里写死', () => {
    // required 渲染的星号带 aria-hidden，对读屏隐身；文案里手写 "*" 则会
    // 混进可访问名——实测 Field htmlFor + Select 的按钮名是「账户 *」，
    // 读屏会念成「账户 星号」。改用 required 一处根治。
    const hardcoded: string[] = [];
    for (const [file, code] of sources) {
      if (file.includes('/components/ui/')) continue;
      for (const m of code.matchAll(/\blabel=(?:"[^"]*"|\{`[^`]*`\}|\{'[^']*'\})/g)) {
        if (m[0].includes('*')) {
          hardcoded.push(
            `${file.replace(SRC, 'src/')}:${code.slice(0, m.index).split('\n').length}`,
          );
        }
      }
    }
    expect(hardcoded).toEqual([]);
  });

  it('每个控件的 id 至少被一处关联引用，不留「白写的 id」', () => {
    // 反过来的漏法：控件写了 id，Field 却忘了 htmlFor。上面那条只查
    // 「htmlFor 指向的 id 存在」，查不出「id 没人指向」——RulesSection 的「关键词」
    // Input 就是这么坏的：id 有、htmlFor 没有，两边都通过，读屏却读不出字段名。
    // 引用方 = htmlFor / aria-labelledby / aria-controls / aria-describedby / url(#..)。
    const REF_ATTRS = 'htmlFor|aria-labelledby|aria-controls|aria-describedby|for';
    const orphans: string[] = [];
    for (const [file, code] of sources) {
      if (file.includes('/components/ui/')) continue; // 组件内部自管 id
      const refs = new Set([
        ...matchAll(code, new RegExp(`\\b(?:${REF_ATTRS})="([^"]*)"`, 'g')),
        ...matchAll(
          code,
          new RegExp(`\\b(?:${REF_ATTRS})=\\{\`([^\`]*)\``, 'g'),
        ).map((s) => s.replace(/\$\{[^}]+\}/g, '')),
        // recharts/SVG 的渐变 id：fill="url(#dashNetGradient)"，不是 a11y 关联
        ...matchAll(code, /url\(#([^)]*)\)/g),
      ]);
      for (const m of code.matchAll(/\bid="([^"]*)"/g)) {
        if (!refs.has(m[1])) {
          orphans.push(
            `${file.replace(SRC, 'src/')}:${code.slice(0, m.index).split('\n').length} id=${m[1]}`,
          );
        }
      }
      // 同上，但 id 写成模板串的：id={`${uid}-keyword`}。插值部分两边都抹掉再比。
      for (const m of code.matchAll(/\bid=\{`([^`]*)`\}/g)) {
        const literal = m[1].replace(/\$\{[^}]+\}/g, '');
        if (!refs.has(literal)) {
          orphans.push(
            `${file.replace(SRC, 'src/')}:${code.slice(0, m.index).split('\n').length} id={\`${m[1]}\`}`,
          );
        }
      }
    }
    expect(orphans).toEqual([]);
  });
});

describe('Select 调用点都有名字', () => {
  /** 取 id / htmlFor 的"表达式文本"：字面量去掉引号，模板串去掉反引号，两边可比 */
  const attrExpr = (attrs: string, name: string) => {
    const lit = attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];
    if (lit !== undefined) return lit;
    return attrs.match(new RegExp(`\\b${name}=\\{\`([^\`]*)\``))?.[1];
  };

  it('每个 <Select> 都有 aria-label，或 id 能在同文件找到 htmlFor 指向它', () => {
    // 实测（Playwright a11y snapshot）：<label for> 对 <button role=combobox>
    // 是生效的，取得到名字。所以有 id + 同名 htmlFor 就算有名字，不必再堆 aria-label。
    const nameless: string[] = [];
    for (const [file, code] of sources) {
      if (file.includes('/components/ui/')) continue;
      // 同文件里所有 htmlFor 指向的目标（字面量 / 模板串统一取表达式文本）
      const targets = new Set(
        [...code.matchAll(/\bhtmlFor="([^"]*)"/g)].map((m) => m[1]).concat(
          [...code.matchAll(/\bhtmlFor=\{`([^`]*)`\}/g)].map((m) => m[1]),
        ),
      );
      for (const m of code.matchAll(/<Select\b([\s\S]*?)\/>/g)) {
        const attrs = m[1];
        if (/\baria-label\s*=/.test(attrs)) continue;
        const id = attrExpr(attrs, 'id');
        if (id !== undefined && targets.has(id)) continue;
        nameless.push(`${file.replace(SRC, 'src/')}:${code.slice(0, m.index).split('\n').length}`);
      }
    }
    expect(nameless).toEqual([]);
  });

  it('至少 3 处 Select 走的是 aria-label 路线（无 label 可挂的控件）', () => {
    const labelled = [...sources.entries()]
      .filter(([f]) => !f.includes('/components/ui/'))
      .flatMap(([file, code]) =>
        [...code.matchAll(/<Select\b([\s\S]*?)\/>/g)]
          .filter((m) => /\baria-label=/.test(m[1]))
          .map(() => file.replace(SRC, 'src/')),
      );
    expect(labelled.length).toBeGreaterThanOrEqual(3);
  });
});

describe('Switch 调用点都有名字', () => {
  it('每个 <Switch> 都带 aria-label 或 aria-labelledby', () => {
    const nameless: string[] = [];
    for (const [file, code] of sources) {
      if (file.includes('/components/ui/')) continue;
      for (const m of code.matchAll(/<Switch\b([\s\S]*?)\/>/g)) {
        const attrs = m[1];
        if (!/aria-label=/.test(attrs) && !/aria-labelledby=/.test(attrs)) {
          nameless.push(file.replace(SRC, 'src/'));
        }
      }
    }
    expect(nameless).toEqual([]);
  });
});
