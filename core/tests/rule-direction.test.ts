/**
 * 规则引擎方向闸门测试
 * -----------------------------------------------------------------
 * 覆盖 mail/importer.ts 的 makeRuleMatcher：
 *   1. 方向闸门：收入流水不再命中支出类规则（反之亦然）
 *   2. 闸门只拦"这一条"：高优先级的方向不对，低优先级方向对的仍然生效
 *   3. 方向一致时闸门是透明的：原来怎么命中现在还怎么命中
 *   4. includes 子串语义**不变**（这次只加闸门，不动匹配本身）
 *   5. 坏数据：categoryId 指向已不存在的分类 → 规则不生效（不能写出悬空 categoryId）
 *   6. 闸门不串味：applyBillCategories:false 关掉的是账单兜底，不是方向闸门
 *
 * 全部走 importTransactions 的公开入口而不是直接测 makeRuleMatcher：
 * 方向闸门依赖"加载规则时那条 LEFT JOIN"，只测纯函数会漏掉 SQL 写错这种最贵的错。
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { ensureSeed } from '../src/db/seed.js';
import { importTransactions } from '../src/mail/importer.ts';
import type { ParsedTx } from '../src/mail/parsers/base.ts';

function makeDb(): Database.Database {
  const db = openDatabase(':memory:');
  migrate(db);
  // 方向闸门读的是 categories.type，不 seed 的话那张表是空的，
  // LEFT JOIN 全给 null，闸门会把每条规则都挡掉——测的就不是闸门而是空表了
  ensureSeed(db);
  const now = Date.now();
  db.prepare(
    `INSERT INTO accounts (id, name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
     VALUES (1, '现金', 'fund', 0, 1, 1, ?, ?)`,
  ).run(now, now);
  return db;
}

/**
 * 按名字取分类 id，不写死数字。
 * 分类 id 是自增的，写死 1/19/29/33 一旦 seed 顺序调整就会静默测错分类。
 */
function cat(name: string): number {
  const row = db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined;
  if (!row) throw new Error(`seed 里没有分类: ${name}`);
  return row.id;
}

/**
 * 测试用到的四个分类，用 getter 而不是常量：beforeEach 每次换新库，
 * getter 保证拿到的 id 来自**当前**那张库。
 */
const CAT = {
  get dailyFood() { return cat('日常餐饮'); },     // expense
  get travel() { return cat('旅行'); },           // expense
  get salary() { return cat('工资'); },           // income
  get otherIncome() { return cat('其他收入'); },   // income
} as const;

let db: Database.Database;
let seq = 0;


/** 插一条规则；priority 默认 10（与批量生成的商户规则同档） */
function rule(keyword: string, categoryId: number, priority = 10, matchField: 'name' | 'merchant' | 'remark' = 'name'): number {
  const id = db
    .prepare(
      `INSERT INTO rules (keyword, matchField, categoryId, priority, enabled, createdAt)
       VALUES (?, ?, ?, ?, 1, ?)`,
    )
    .run(keyword, matchField, categoryId, priority, 1000 + seq++).lastInsertRowid as number;
  return id;
}

/** 造一笔流水；externalId 保证每笔都不被判重逻辑误杀 */
function tx(over: Partial<ParsedTx> = {}): ParsedTx {
  return {
    date: 1_700_000_000_000,
    amount: 10,
    type: 'expense',
    merchant: '中铁网络',
    externalId: `E-${seq++}`,
    ...over,
  };
}

/** 导入后取该笔流水的 categoryId（找不到就是 null） */
function categoryOf(merchant: string): number | null {
  const row = db
    .prepare('SELECT categoryId FROM transactions WHERE name = ? ORDER BY id DESC LIMIT 1')
    .get(merchant) as { categoryId: number | null } | undefined;
  return row?.categoryId ?? null;
}

beforeEach(() => {
  db = makeDb();
  seq = 0;
});
afterAll(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
});

// ══════════════════════════════════════════════════════════════
describe('方向闸门：收入流水不命中支出类规则', () => {
  it('【夹具前提】四个种子分类的收支方向符合预期', () => {
    // 下面每条用例都建立在这四个分类的方向上；哪天 seed 改了方向，
    // 这条会先炸，而不是让一堆用例悄悄测反了轴
    const types = db
      .prepare('SELECT name, type FROM categories WHERE name IN (?,?,?,?)')
      .all('日常餐饮', '旅行', '工资', '其他收入') as Array<{ name: string; type: string }>;
    expect(Object.fromEntries(types.map((t) => [t.name, t.type]))).toEqual({
      日常餐饮: 'expense',
      旅行: 'expense',
      工资: 'income',
      其他收入: 'income',
    });
  });

  it('同一份规则，进账不再被套上支出分类（实测 27 笔跨方向的最小复现）', () => {
    rule('中铁网络', CAT.travel);
    importTransactions(db, [tx({ type: 'income', merchant: '中铁网络' })], 1);
    expect(categoryOf('中铁网络')).toBeNull();
  });

  it('反过来也一样：支出流水不命中收入类规则', () => {
    rule('张俊梅', CAT.otherIncome);
    importTransactions(db, [tx({ type: 'expense', merchant: '张俊梅' })], 1);
    expect(categoryOf('张俊梅')).toBeNull();
  });

  it('方向一致时闸门透明：该命中的照常命中，分类 id 不变', () => {
    rule('中铁网络', CAT.travel);
    importTransactions(db, [tx({ type: 'expense', merchant: '中铁网络' })], 1);
    expect(categoryOf('中铁网络')).toBe(CAT.travel);
  });

  it('收入类规则对进账照常生效（闸门不是把收入分类也一起关掉）', () => {
    rule('腾讯科技', CAT.salary);
    importTransactions(db, [tx({ type: 'income', merchant: '腾讯科技' })], 1);
    expect(categoryOf('腾讯科技')).toBe(CAT.salary);
  });

  it('闸门按流水逐笔判断，不是一刀切：同一批里收支配不同', () => {
    rule('中铁网络', CAT.travel);
    importTransactions(
      db,
      [
        tx({ type: 'expense', merchant: '中铁网络', externalId: 'A' }),
        tx({ type: 'income', merchant: '中铁网络 A', externalId: 'B' }),
      ],
      1,
    );
    // 支出那笔命中；进账那笔商户名带后缀故不匹配任何规则 → 留空
    expect(categoryOf('中铁网络')).toBe(CAT.travel);
    expect(categoryOf('中铁网络 A')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
describe('方向闸门：按优先级跳过方向不对的那条，继续匹配下一条', () => {
  it('高优先级方向不对被跳过，低优先级方向对的仍生效', () => {
    rule('滴滴出行', CAT.travel, 50);       // expense，方向与进账不符
    rule('滴滴出行', CAT.salary, 10);       // income，方向对
    importTransactions(db, [tx({ type: 'income', merchant: '滴滴出行' })], 1);
    expect(categoryOf('滴滴出行')).toBe(CAT.salary);
  });

  it('跳过一条不该让整条流水失去分类（不是直接 return null）', () => {
    rule('美团', CAT.travel, 99);
    rule('美团', CAT.otherIncome, 1);
    const res = importTransactions(db, [tx({ type: 'income', merchant: '美团' })], 1);
    expect(res.imported).toBe(1);
    expect(categoryOf('美团')).toBe(CAT.otherIncome);
  });

  it('方向全不对时，才落到 null（而不是随手挂个方向错的分类）', () => {
    rule('美团', CAT.travel, 50);
    rule('美团', CAT.dailyFood, 10);
    importTransactions(db, [tx({ type: 'income', merchant: '美团' })], 1);
    expect(categoryOf('美团')).toBeNull();
  });

  it('优先级顺序仍然决定同方向规则之间的胜负（闸门没有把顺序打乱）', () => {
    rule('美团', CAT.dailyFood, 10);
    rule('美团', CAT.travel, 50);
    importTransactions(db, [tx({ type: 'expense', merchant: '美团' })], 1);
    expect(categoryOf('美团')).toBe(CAT.travel);
  });
});

// ══════════════════════════════════════════════════════════════
describe('includes 子串语义不变', () => {
  it('部分包含即命中（不是整名相等）', () => {
    rule('滴滴出行', CAT.travel);
    importTransactions(db, [tx({ type: 'expense', merchant: '滴滴出行科技有限公司' })], 1);
    expect(categoryOf('滴滴出行科技有限公司')).toBe(CAT.travel);
  });

  it('includes 是单向的：keyword 比商户名长时不可能命中', () => {
    // '"稀宇".includes("上海稀宇科技有限公司")' 恒为 false。这条断言是为了钉住
    // includes 的**方向**：拿 keyword 找商户名包含它，不是反过来。方向闸门是在
    // 这层之上加的，不能顺手把这里的语义也改了。
    rule('上海稀宇科技有限公司', CAT.travel);
    importTransactions(db, [tx({ type: 'expense', merchant: '稀宇' })], 1);
    expect(categoryOf('稀宇')).toBeNull();
  });

  it('单字符 keyword 仍会 includes 命中（闸门不管长度，长度靠 enabled=0 治）', () => {
    // 方向闸门解决的是"配错方向"，解决不了"keyword 太泛"：这条商户名是支出、
    // 规则也指向支出分类，方向完全正确，可"平"照样把"拼多多"抢走了。
    // 所以单字符规则是靠 scripts/disable-short-rules.ts 停用的，不是靠闸门。
    rule('平', CAT.travel);
    importTransactions(db, [tx({ type: 'expense', merchant: '拼多多平台商户' })], 1);
    expect(categoryOf('拼多多平台商户')).toBe(CAT.travel);
  });

  it('不包含就不命中', () => {
    rule('盒马', CAT.dailyFood);
    importTransactions(db, [tx({ type: 'expense', merchant: '永辉超市' })], 1);
    expect(categoryOf('永辉超市')).toBeNull();
  });

  it('matchField=\'remark\' 的规则照样按备注匹配，且同样受方向闸门约束', () => {
    rule('退款', CAT.otherIncome, 10, 'remark');
    importTransactions(
      db,
      [
        tx({ type: 'expense', merchant: '某商户', remark: '退款', externalId: 'R1' }),
        tx({ type: 'income', merchant: '某商户B', remark: '退款', externalId: 'R2' }),
      ],
      1,
    );
    // 支出那笔：备注命中但方向不符（收入分类）→ 留空
    expect(categoryOf('某商户')).toBeNull();
    expect(categoryOf('某商户B')).toBe(CAT.otherIncome);
  });

  it('规则表为空时方向闸门不炸（空规则短路仍返回 null）', () => {
    const res = importTransactions(db, [tx()], 1);
    expect(res.imported).toBe(1);
    expect(categoryOf('中铁网络')).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════
describe('坏数据与开关隔离', () => {
  it('categoryId 指向不存在的分类 → 规则不生效，不写出悬空 categoryId', () => {
    // rules.categoryId 没有外键，悬空引用是可能的
    rule('中铁网络', 9999);
    importTransactions(db, [tx({ type: 'expense', merchant: '中铁网络' })], 1);
    expect(categoryOf('中铁网络')).toBeNull();
  });

  it('悬空规则被跳过后，方向正确的下一条仍能命中', () => {
    rule('中铁网络', 9999, 50);
    rule('中铁网络', CAT.travel, 10);
    importTransactions(db, [tx({ type: 'expense', merchant: '中铁网络' })], 1);
    expect(categoryOf('中铁网络')).toBe(CAT.travel);
  });

  it('applyBillCategories:false 只关账单兜底，不会把方向闸门一起关掉', () => {
    rule('中铁网络', CAT.travel);
    importTransactions(db, [tx({ type: 'income', merchant: '中铁网络' })], 1, { applyBillCategories: false });
    expect(categoryOf('中铁网络')).toBeNull();   // 闸门仍然拦着
  });

  it('applyRules:false 时规则整体不生效（闸门也不参与）', () => {
    rule('中铁网络', CAT.travel);
    importTransactions(db, [tx({ type: 'expense', merchant: '中铁网络' })], 1, { applyRules: false });
    expect(categoryOf('中铁网络')).toBeNull();
  });

  it('enabled=0 的规则照旧不参与匹配（闸门不是它唯一的过滤条件）', () => {
    rule('中铁网络', CAT.travel);
    db.prepare('UPDATE rules SET enabled = 0').run();
    importTransactions(db, [tx({ type: 'expense', merchant: '中铁网络' })], 1);
    expect(categoryOf('中铁网络')).toBeNull();
  });
});
