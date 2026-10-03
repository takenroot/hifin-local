/**
 * 交易列表关键字搜索纯逻辑单测
 * ---------------------------------------------------------------
 * 覆盖：匹配范围（name / 商户名 / remark / 分类名）、大小写、trim、空关键字不过滤，
 * 以及"关键字叠加在筛选之上"这条不变量（两者取交集，不是互相覆盖）。
 */
import { describe, it, expect } from 'vitest';
import type { Transaction } from '@/db';
import {
  filterTxByKeyword,
  txMatchesKeyword,
  type TxNameResolver,
} from '@/features/transactions/TransactionListView';
import { applyFilter, summarize } from '@/features/transactions/balance';
import { groupTransactions } from '@/features/transactions/grouping';

/* ─────────── 夹具 ─────────── */

let seq = 0;
function tx(partial: Partial<Transaction> & { name: string }): Transaction {
  seq += 1;
  return {
    id: seq,
    type: 'expense',
    amount: 10,
    date: new Date(2026, 0, seq).getTime(),
    accountId: 1,
    includeInAsset: true,
    createdAt: seq,
    ...partial,
  } as Transaction;
}

const categories: Record<number, string> = { 7: '餐饮', 8: '交通' };
const merchants: Record<number, string> = { 3: '蜜雪冰城' };

const resolve: TxNameResolver = (kind, id) =>
  kind === 'category' ? categories[id] : merchants[id];

const LIST: Transaction[] = [
  tx({ name: '蜜雪冰城', categoryId: 7, merchantId: 3, remark: '柠檬水' }),
  tx({ name: 'Starbucks 拿铁', categoryId: 7, remark: '下午续命' }),
  tx({ name: '地铁', categoryId: 8 }),
  tx({ name: '工资', type: 'income', categoryId: undefined, remark: '九月薪资' }),
  tx({ name: '房租', type: 'expense', categoryId: undefined, remark: '水电燃气' }),
];

const names = (list: Transaction[]) => list.map((t) => t.name);
const kw = (key: string) => names(filterTxByKeyword(LIST, key, resolve));

/* ─────────── txMatchesKeyword ─────────── */

describe('txMatchesKeyword · 匹配范围', () => {
  const t = LIST[0];

  it('交易 name 命中', () => {
    expect(txMatchesKeyword(t, '蜜雪', { merchantName: '蜜雪冰城' })).toBe(true);
  });

  it('商户名命中（name 不含关键字时）', () => {
    const onlyMerchant = tx({ name: '扫码付款', merchantId: 3 });
    expect(txMatchesKeyword(onlyMerchant, '蜜雪', { merchantName: '蜜雪冰城' })).toBe(true);
  });

  it('remark 命中', () => {
    expect(txMatchesKeyword(t, '柠檬', { categoryName: '餐饮' })).toBe(true);
  });

  it('分类名命中', () => {
    const onlyCategory = tx({ name: '午饭', categoryId: 7 });
    expect(txMatchesKeyword(onlyCategory, '餐饮', { categoryName: '餐饮' })).toBe(true);
  });

  it('四个字段都不含则不命中', () => {
    const bare = tx({ name: '便利店', remark: '买了水' });
    expect(txMatchesKeyword(bare, '蜜雪', { categoryName: '餐饮' })).toBe(false);
    expect(txMatchesKeyword(bare, '咖啡')).toBe(false);
  });
});

describe('txMatchesKeyword · 大小写与空白', () => {
  it('不区分大小写', () => {
    expect(txMatchesKeyword(LIST[1], 'starbucks')).toBe(true);
    expect(txMatchesKeyword(LIST[1], 'STARBUCKS')).toBe(true);
    expect(txMatchesKeyword(LIST[1], 'StArBuCkS')).toBe(true);
  });

  it('关键字首尾空白被 trim，不影响命中', () => {
    expect(txMatchesKeyword(LIST[0], '  蜜雪  ')).toBe(true);
  });

  it('关键字 trim 后为空 = 不过滤（恒 true）', () => {
    for (const empty of ['', ' ', '\t', '\n', '   ']) {
      expect(txMatchesKeyword(LIST[0], empty)).toBe(true);
      expect(txMatchesKeyword(LIST[3], empty)).toBe(true);
    }
  });

  it('是子串匹配，不是全等', () => {
    expect(txMatchesKeyword(LIST[0], '雪冰')).toBe(true);
  });
});

/* ─────────── filterTxByKeyword ─────────── */

describe('filterTxByKeyword', () => {
  it('空关键字原样返回同一个引用（不触发多余重渲染）', () => {
    expect(filterTxByKeyword(LIST, '', resolve)).toBe(LIST);
    expect(filterTxByKeyword(LIST, '   ', resolve)).toBe(LIST);
  });

  it('「蜜雪」只留命中 name / 商户名的交易', () => {
    expect(kw('蜜雪')).toEqual(['蜜雪冰城']);
  });

  it('「蜜雪」按商户名命中——name 与商户名无关的也能搜到', () => {
    const list = [tx({ name: '扫码付款', merchantId: 3 })];
    expect(names(filterTxByKeyword(list, '蜜雪', resolve))).toEqual(['扫码付款']);
  });

  it('分类名也能搜到（命中多笔时按原顺序返回）', () => {
    expect(kw('餐饮')).toEqual(['蜜雪冰城', 'Starbucks 拿铁']);
  });

  it('备注可搜', () => {
    expect(kw('柠檬水')).toEqual(['蜜雪冰城']);
    expect(kw('薪资')).toEqual(['工资']);
  });

  it('大小写不敏感', () => {
    expect(kw('starbucks')).toEqual(['Starbucks 拿铁']);
  });

  it('无命中时返回空数组', () => {
    expect(kw('不存在的关键字zzz')).toEqual([]);
  });

  it('不会误伤其它字段（账户名/金额不参与匹配）', () => {
    const list = [tx({ name: '地铁', accountId: 999 })];
    expect(filterTxByKeyword(list, '999', resolve)).toEqual([]);
  });

  it('缺少 categoryId / merchantId / remark 的交易不会因 undefined 报错', () => {
    const bare = tx({ name: '地铁', categoryId: undefined, merchantId: undefined, remark: undefined });
    expect(() => filterTxByKeyword([bare], '地铁', resolve)).not.toThrow();
    expect(filterTxByKeyword([bare], '地铁', resolve)).toEqual([bare]);
  });
});

/* ─────────── 与既有筛选 / 分组 / 统计叠加 ─────────── */

describe('与筛选、分组、统计叠加', () => {
  it('先按筛选再按关键字，两者取交集', () => {
    // 支出类里再搜「餐饮」
    const byType = applyFilter(LIST, { types: ['expense'] });
    const both = filterTxByKeyword(byType, '餐饮', resolve);
    expect(names(both)).toEqual(['蜜雪冰城', 'Starbucks 拿铁']);
    // 换成"工资"（收入类）→ 与"支出"筛选交集为空
    expect(filterTxByKeyword(byType, '工资', resolve)).toEqual([]);
  });

  it('「共 N 笔」计数跟着关键字走', () => {
    const all = summarize(LIST);
    const hit = summarize(filterTxByKeyword(LIST, '蜜雪', resolve));
    expect(all.count).toBe(5);
    expect(hit.count).toBe(1);
    expect(hit.expense).toBe(10); // 只剩蜜雪冰城那一笔
  });

  it('清空关键字后完全恢复原列表', () => {
    // 空关键字原样返回入参引用，所以"恢复"= 拿回未搜索的那份列表
    expect(filterTxByKeyword(LIST, '', resolve)).toBe(LIST);
    const once = filterTxByKeyword(LIST, '蜜雪', resolve);
    const restored = filterTxByKeyword(once, '', resolve);
    expect(restored).toBe(once); // 引用不变（组件不会因清空而重算）
    expect(names(filterTxByKeyword(LIST, '', resolve))).toEqual(names(LIST));
  });

  it('分组维度切换与关键字正交：任意维度下分组总数都等于命中数', () => {
    for (const dim of ['day', 'week', 'month', 'year'] as const) {
      const hit = filterTxByKeyword(LIST, '蜜雪', resolve);
      const grouped = groupTransactions(hit, dim);
      expect(grouped.reduce((s, g) => s + g.txs.length, 0)).toBe(hit.length);
    }
  });
});
