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
const sources = new Map(files.map((f) => [f, readFileSync(f, 'utf8')]));
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
    // 全仓扫 <label> 会命中 12 个不在本任务范围内的文件（Select/Switch/各 section），
    // 那些属于无障碍整改的另一趟；这里只守住自己改过的表单，防止有人又抄一份回去。
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
