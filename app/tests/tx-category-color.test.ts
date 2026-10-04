/**
 * 交易行分类 chip 的取色契约（ISSUE-006）
 * ---------------------------------------------------------------
 * 背景：分类名曾直接用分类自带图标色（34 色），暗色卡片底 #171a21 上只有
 *      2.49~2.93:1（数码电器 #7e22ce / 停车费 #1d4ed8 / 加油 #0369a1），
 *      darkmode-audit 记为「其他文本不可见」issue。
 * 约定：文字走中性 token（text-text dark:text-text-dark），
 *      分类色只留作前置 8px 圆点——图形按 1.4.11 只需 3:1。
 *
 * 测法：同 ui-primitives.test.ts，renderToStaticMarkup 断**真实渲染输出**，
 *      有人把 style={{ color: cat.color }} 加回来就会红。
 */
import { describe, it, expect } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TxRow } from '@/features/transactions/TransactionListView';
import type { Account, Category, Transaction } from '@/db';

const noop = () => {};

/** darkmode-audit 实测低于 3:1 的三个分类色 */
const DARK_FATAL = ['#7e22ce', '#1d4ed8', '#0369a1'];

function tx(partial: Partial<Transaction> = {}): Transaction {
  return {
    id: 1,
    type: 'expense',
    name: '超市',
    amount: 128.5,
    date: new Date(2026, 0, 15, 12, 30).getTime(),
    accountId: 1,
    categoryId: 7,
    includeInAsset: true,
    createdAt: 1,
    ...partial,
  };
}

function cat(partial: Partial<Category> & { color: string }): Category {
  return { id: 7, name: '数码电器', group: '购物', type: 'expense', ...partial };
}

function render(category: Category | undefined, t = tx()) {
  return renderToStaticMarkup(
    h(TxRow, {
      tx: t,
      categories: category ? [category] : [],
      accounts: [{ id: 1, name: '招行卡', type: 'debit', createdAt: 1, updatedAt: 1 } as Account],
      tags: [],
      merchants: [],
      onEdit: noop,
      onDelete: noop,
    }),
  );
}

describe('交易行分类 chip 取色', () => {
  it('分类名不再被分类色上色——三个暗底下 2.5~2.9:1 的色都不进 style', () => {
    for (const color of DARK_FATAL) {
      // 扫遍整行的内联 style：允许 background（图标底 / 圆点），禁止任何 color 声明
      const styles = [...render(cat({ color })).matchAll(/style="([^"]*)"/g)].map((m) => m[1]);
      expect(styles.length).toBeGreaterThan(0);
      for (const s of styles) expect(s, `行内出现了 color 声明：${s}`).not.toMatch(/(^|;)\s*color\s*:/);
    }
  });

  it('分类名用中性 token，明暗两套都配了', () => {
    const out = render(cat({ color: '#7e22ce' }));
    const chip = out.match(
      /<span class="inline-flex items-center gap-1 text-text dark:text-text-dark">(?:<span[^>]*><\/span>)?数码电器<\/span>/,
    );
    expect(chip, `分类名 span 没带中性 token：${out}`).toBeTruthy();
  });

  it('分类色保留为前置 8px 圆点（w-2 h-2 rounded-full + 该色背景）', () => {
    const out = render(cat({ color: '#0369a1' }));
    expect(out).toMatch(/<span class="w-2 h-2 rounded-full flex-none" style="background:#0369a1"><\/span>/);
  });

  it('无分类时回落到「转账」/「—」，不留空圆点', () => {
    const transfer = render(undefined, tx({ type: 'transfer', categoryId: undefined }));
    expect(transfer).toContain('转账');
    expect(transfer).not.toContain('rounded-full flex-none');

    const plain = render(undefined, tx({ categoryId: undefined }));
    expect(plain).toContain('—');
  });
});
