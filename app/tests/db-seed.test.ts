import { describe, it, expect, beforeEach } from 'vitest';
import { db, ensureSeed } from '@/db';

// fake-indexeddb 在 setup.ts 中已 import 'fake-indexeddb/auto'
// 每个测试用例前清空数据库，确保干净状态。

beforeEach(async () => {
  await db.delete();
  // 重新打开 db（delete 会关闭连接）
  await db.open();
});

describe('ensureSeed', () => {
  it('首次调用：写入 33 个默认分类', async () => {
    await ensureSeed();
    const count = await db.categories.count();
    expect(count).toBe(33);
  });

  it('幂等：连续调用两次分类数不翻倍', async () => {
    await ensureSeed();
    await ensureSeed();
    const count = await db.categories.count();
    expect(count).toBe(33);
  });

  it('幂等：连续调用两次标签数不翻倍', async () => {
    await ensureSeed();
    await ensureSeed();
    const tagCount = await db.tags.count();
    // 4 个种子标签
    expect(tagCount).toBe(4);
  });

  it('种子分类包含支出 / 收入两类', async () => {
    await ensureSeed();
    const expenseCount = await db.categories.where('type').equals('expense').count();
    const incomeCount = await db.categories.where('type').equals('income').count();
    expect(expenseCount).toBeGreaterThan(0);
    expect(incomeCount).toBeGreaterThan(0);
    expect(expenseCount + incomeCount).toBe(33);
  });

  it('种子分类包含若干 group', async () => {
    await ensureSeed();
    const all = await db.categories.toArray();
    const groups = new Set(all.map((c) => c.group));
    expect(groups.size).toBeGreaterThanOrEqual(5);
  });

  it('若用户已添加分类，再调用 ensureSeed 不会覆盖', async () => {
    await ensureSeed();
    await db.categories.add({ name: '我的自定义', group: '自定义', type: 'expense' });
    expect(await db.categories.count()).toBe(34);
    await ensureSeed();
    expect(await db.categories.count()).toBe(34);
  });
});
