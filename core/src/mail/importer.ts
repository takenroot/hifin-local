/**
 * 将 ParsedTx[] 批量导入到 hifin 库：
 *   1. 在事务中插入 transactions
 *   2. 联动账户余额（expense - amount，income + amount）
 *   3. 分类：规则引擎（rules 表）优先，其次账单自带分类映射（category-map），再次 null
 *   4. account 不存在 → 抛出；重复（同 accountId+date+amount+merchant）跳过
 */

import type Database from 'better-sqlite3';
import type { ParsedTx } from './parsers/base.js';
import { resolveBillCategory } from '../bill/category-map.js';

export interface ImportOptions {
  /** 默认 1 */
  spaceId?: number;
  /** 是否按 rules 自动分类（默认 true） */
  applyRules?: boolean;
  /**
   * 是否用账单自带的分类做兜底（默认 true）。
   * 只对 platform 为 alipay/wechat 的账单生效；邮件账单解析器不带 platform，
   * 天然不受影响，这里留开关是为了给"只想要规则引擎结果"的调用方一条退路。
   */
  applyBillCategories?: boolean;
  /** 默认 true：跳过同账户同一天同金额同商户的重复 */
  dedupe?: boolean;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

interface RuleRow {
  id: number;
  keyword: string;
  matchField: 'name' | 'merchant' | 'remark';
  categoryId: number;
  priority: number;
  enabled: number;
}

/** categories 表里的一行：名字 → id，且带收支方向供类型闸门复查 */
interface CategoryRow {
  id: number;
  name: string;
  type: string;
}

export function importTransactions(
  db: Database.Database,
  parsed: ParsedTx[],
  accountId: number,
  optionsOrSpaceId?: ImportOptions | number,
): ImportResult {
  const opts: ImportOptions =
    typeof optionsOrSpaceId === 'number'
      ? { spaceId: optionsOrSpaceId }
      : optionsOrSpaceId ?? {};

  const spaceId = opts.spaceId ?? 1;
  const applyRules = opts.applyRules ?? true;
  const applyBillCategories = opts.applyBillCategories ?? true;
  const dedupe = opts.dedupe ?? true;

  const account = db.prepare('SELECT id, balance FROM accounts WHERE id = ?').get(accountId) as
    | { id: number; balance: number }
    | undefined;
  if (!account) {
    throw new Error(`Account ${accountId} not found`);
  }

  // 预加载规则（按 priority DESC）
  const rules: RuleRow[] = applyRules
    ? (db
            .prepare(
              'SELECT id, keyword, matchField, categoryId, priority, enabled FROM rules WHERE enabled = 1 ORDER BY priority DESC',
            )
            .all() as RuleRow[])
    : [];

  const findCategory = makeRuleMatcher(rules);

  // 账单自带分类映射：分类名 → id。查表一次建索引，避免逐行查库。
  // 名字对不上（用户改过分类名、或该库压根没这个分类）就当没映射。
  const categoryByName = new Map<string, CategoryRow>();
  if (applyBillCategories) {
    const rows = db.prepare('SELECT id, name, type FROM categories').all() as CategoryRow[];
    for (const r of rows) {
      // 同名分类取先出现的那个：分类表没约束名字唯一，但种子数据里没有重名，
      // 真有重名时"第一个"至少是确定性的，不会让同一份账单两次导入结果不同
      if (!categoryByName.has(r.name)) categoryByName.set(r.name, r);
    }
  }

  const insert = db.prepare(`
    INSERT INTO transactions
      (type, name, amount, date, accountId, categoryId, remark, includeInAsset, spaceId, createdAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBalance = db.prepare(
    'UPDATE accounts SET balance = balance + ?, updatedAt = ? WHERE id = ?',
  );

  const dupCheck = db.prepare(`
    SELECT 1 FROM transactions
     WHERE accountId = ? AND amount = ? AND date = ?
       AND name = ?
     LIMIT 1
  `);

  let imported = 0;
  let skipped = 0;
  const now = Date.now();

  /**
   * 规则引擎没命中时，用账单自带分类兜底。
   *
   * 两道保险：
   *   1. resolveBillCategory 内部已按收支方向做过类型闸门；
   *   2. 这里再按 categories.type 复查一次——映射表是按名字写的，
   *      而库里的分类名/类型可以被用户改过，不能只信代码里的常量。
   */
  function findBillCategoryId(it: ParsedTx): number | null {
    if (!applyBillCategories) return null;
    if (!it.platform || !it.billCategory) return null;
    const name = resolveBillCategory(it.platform, it.billCategory, it.type);
    if (!name) return null;
    const row = categoryByName.get(name);
    if (!row) return null;
    if (row.type !== it.type) return null;
    return row.id;
  }

  const tx = db.transaction((items: ParsedTx[]) => {
    for (const it of items) {
      if (!it || !isFinite(it.amount) || it.amount <= 0) {
        skipped++;
        continue;
      }
      if (dedupe) {
        const dup = dupCheck.get(accountId, it.amount, it.date, it.merchant) as unknown;
        if (dup) {
          skipped++;
          continue;
        }
      }
      // 分类优先级：规则引擎 > 账单自带分类映射 > null（留空）
      const categoryId = findCategory(it.merchant, it.remark) ?? findBillCategoryId(it);
      insert.run(
        it.type,
        it.merchant,
        it.amount,
        it.date,
        accountId,
        categoryId,
        it.remark ?? null,
        1,
        spaceId,
        now,
      );
      // expense → 余额减少；amount 字段为正数
      const delta = it.type === 'income' ? it.amount : -it.amount;
      updateBalance.run(delta, now, accountId);
      imported++;
    }
  });

  tx(parsed);

  return { imported, skipped };
}

function makeRuleMatcher(rules: RuleRow[]) {
  if (rules.length === 0) return () => null as number | null;
  return (merchant: string, remark?: string | null): number | null => {
    for (const r of rules) {
      const kw = (r.keyword || '').trim();
      if (!kw) continue;
      const field =
        r.matchField === 'name' ? merchant : r.matchField === 'remark' ? (remark ?? '') : merchant;
      if (field && field.includes(kw)) {
        return r.categoryId;
      }
    }
    return null;
  };
}