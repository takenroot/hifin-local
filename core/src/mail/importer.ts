/**
 * 将 ParsedTx[] 批量导入到 hifin 库：
 *   1. 在事务中插入 transactions
 *   2. 联动账户余额（expense - amount，income + amount）
 *   3. 若启用 rules：先查 rules 表按优先级自动匹配 categoryId
 *   4. account 不存在 → 抛出；重复（同 accountId+date+amount+merchant）跳过
 */

import type Database from 'better-sqlite3';
import type { ParsedTx } from './parsers/base.js';

export interface ImportOptions {
  /** 默认 1 */
  spaceId?: number;
  /** 是否按 rules 自动分类（默认 true） */
  applyRules?: boolean;
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
      const categoryId = findCategory(it.merchant, it.remark);
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