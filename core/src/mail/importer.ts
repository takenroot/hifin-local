/**
 * 将 ParsedTx[] 批量导入到 hifin 库：
 *   1. 在事务中插入 transactions（含 source/externalId/paymentMethod/status 四个溯源字段）
 *   2. 联动账户余额（expense - amount，income + amount）
 *   3. 分类：规则引擎（rules 表）优先，其次账单自带分类映射（category-map），再次 null
 *   4. account 不存在 → 抛出；重复行跳过（判重规则见下方 dedupe 分支）
 *
 * 规则引擎有一条**方向闸门**：rules 表没有方向列，而匹配是 includes 子串匹配，
 * 收入流水会被套上支出分类的规则（实测 27 笔，如"中铁网络"这笔进账被归成"旅行"）。
 * 闸门口径与 bill/category-map.ts 的 resolveBillCategory 一致，见 makeRuleMatcher。
 */

import type Database from 'better-sqlite3';
import type { ParsedTx } from './parsers/base.js';
import { resolveBillCategory, type TxDirection } from '../bill/category-map.js';

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
  /**
   * 默认 true：跳过重复行。
   * 判重口径随数据而变——有平台单号走 (source, externalId) 精确判重，
   * 没有则退回 accountId+date+amount+merchant 四字段启发式。
   */
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
  /**
   * 这条规则指向的分类的收支方向，来自预 join 的 categories.type；null = 分类不存在。
   *
   * 单独摘出来而不是让 matcher 反查 categories，是为了让 makeRuleMatcher 保持纯函数：
   * 方向闸门要读什么，在**加载规则那一步**就一次性备好，匹配时只做比较。
   */
  categoryType: TxDirection | null;
}

/** 规则匹配器：商户名 + 收支方向（+ 备注）→ categoryId；不匹配返回 null */
type RuleMatcher = (merchant: string, txType: TxDirection, remark?: string | null) => number | null;

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

  // 预加载规则（按 priority DESC），顺带把 categories.type join 进来供方向闸门用。
  //
  // 选"预 join"而不是"把 categories 当参数传进 matcher"，因为下面那份按名字查的
  // categoryByName 是 **applyBillCategories 开关控制的**：一旦复用它，调用方关掉
  // 账单兜底就会连带把方向闸门也关掉——而 applyRules 与 applyBillCategories 本来
  // 是两个互不相干的开关。join 进 SELECT 则只有一条语句，也不会出现两次查询
  // 读到不同快照（:8787 的 REST 服务可能正在改分类表）。
  const rules: RuleRow[] = applyRules
    ? (db
            .prepare(
              `SELECT r.id, r.keyword, r.matchField, r.categoryId, r.priority, r.enabled,
                      c.type AS categoryType
                 FROM rules r
                 LEFT JOIN categories c ON c.id = r.categoryId
                WHERE r.enabled = 1
                ORDER BY r.priority DESC`,
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
      (type, name, amount, date, accountId, categoryId, remark, includeInAsset, spaceId, createdAt,
       source, externalId, paymentMethod, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateBalance = db.prepare(
    'UPDATE accounts SET balance = balance + ?, updatedAt = ? WHERE id = ?',
  );

  /**
   * 精确去重：有平台单号时按 (source, externalId) 判重。
   *
   * 刻意**不带 accountId**：idx_tx_source_external 是全局部分唯一索引，
   * 一笔平台交易在账上只能存在一处，这里若把 accountId 加上，查询会漏判，
   * 真正报错的就变成 INSERT 时的 UNIQUE 约束异常了。
   */
  const dupByExternalId = db.prepare(`
    SELECT 1 FROM transactions
     WHERE source IS ? AND externalId = ?
     LIMIT 1
  `);

  /** 启发式去重：无单号时退回四字段（账户+金额+时间+商户） */
  const dupCheck = db.prepare(`
    SELECT 1 FROM transactions
     WHERE accountId = ? AND amount = ? AND date = ?
       AND name = ?
     LIMIT 1
  `);

  /**
   * 空值 / 占位符一律归 null。
   *
   * 两家账单用半角 "/" 表示"这格没内容"，它会出现在**每一列**
   * （交易对方、支付方式、备注…），不是有效值。解析层（app/csv.ts）已经规整过，
   * 这里再兜一次底：直连 importTransactions 的调用方（邮件解析器、将来的
   * 其它集成）绕过了解析层，不兜就会把 "/" 当内容存进库里。
   *
   * 口径必须和解析层一致，否则同一份账单走两条路会得到不同的库：
   * 解析层把 paymentMethod='/' 变成 NULL，这里也得变成 NULL。
   */
  const blankToNull = (v: string | null | undefined): string | null => {
    if (v === undefined || v === null) return null;
    const t = v.trim();
    if (!t || t === '/') return null;
    return t;
  };

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

      // 溯源字段先归一：空串→NULL，`/`→NULL（平台"这格没内容"的占位符）
      const source = blankToNull(it.source);
      const externalId = blankToNull(it.externalId);
      const paymentMethod = blankToNull(it.paymentMethod);
      const status = blankToNull(it.status);
      const remark = blankToNull(it.remark);

      if (dedupe) {
        /**
         * 两条去重路径二选一，取决于有没有平台单号：
         *   - 有 externalId → (source, externalId) 精确判重。同一笔平台交易
         *     不可能有两行，哪怕它和别的行同金额同时间同商户。
         *   - 无 externalId → 退回四字段启发式（账户+金额+时间+商户）。这是
         *     邮件账单、银行流水这类没有平台单号的来源唯一的办法。
         *
         * 两条路径不叠加：叠加会让"同一天同金额同商户的两笔真实消费"被误杀——
         * 那恰好是启发式最经典的误判，也正是引入单号要解决的问题。
         */
        const dup = externalId
          ? (dupByExternalId.get(source, externalId) as unknown)
          : (dupCheck.get(accountId, it.amount, it.date, it.merchant) as unknown);
        if (dup) {
          skipped++;
          continue;
        }
      }
      // 分类优先级：规则引擎 > 账单自带分类映射 > null（留空）
      // 方向由 it.type 带进规则引擎：闸门要求规则的 categories.type 与流水方向一致
      const categoryId = findCategory(it.merchant, it.type, remark) ?? findBillCategoryId(it);
      try {
        insert.run(
          it.type,
          it.merchant,
          it.amount,
          it.date,
          accountId,
          categoryId,
          remark,
          1,
          spaceId,
          now,
          source,
          externalId,
          paymentMethod,
          status,
        );
      } catch (err) {
        /**
         * 撞上 idx_tx_source_external 时按"跳过"计，不让整批导入炸掉。
         *
         * 正常路径下上面的判重已经拦住了，但 dedupe:false 是显式关掉判重的，
         * 这时唯一索引是最后一道防线。SQLite 默认的 ON CONFLICT ABORT 只回滚
         * 这一条语句（不是整个事务），所以 catch 住之后循环可以安全继续。
         */
        if (isUniqueViolation(err)) {
          skipped++;
          continue;
        }
        throw err;
      }
      // expense → 余额减少；amount 字段为正数
      const delta = it.type === 'income' ? it.amount : -it.amount;
      updateBalance.run(delta, now, accountId);
      imported++;
    }
  });

  tx(parsed);

  return { imported, skipped };
}

/** 是不是唯一索引/唯一约束冲突（而不是别的数据库错误，比如 CHECK 失败） */
function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  const message = (err as { message?: unknown }).message;
  return (
    code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    (typeof message === 'string' && message.includes('UNIQUE constraint failed'))
  );
}

/**
 * 规则匹配器：按 priority 顺序返回第一条命中的规则的 categoryId。
 *
 * 方向闸门（本次新增）
 * -----------------------------------------------------------------
 * rules 表**没有方向列**，匹配又是 includes 子串匹配，于是"规则说去哪个分类"
 * 和"这笔流水是收是支"完全脱钩：只要商户名里含关键字就会命中。实测全库 817 笔
 * 回放有 27 笔跨方向错配——20 笔进账被套上支出分类（"中铁网络"→旅行），
 * 另有 7 笔反过来（支出"张俊梅 (谨)"命中收入规则→其他收入）。
 *
 * 闸门口径与 bill/category-map.ts 的 resolveBillCategory **故意保持一致**：
 * 规则指向的 categories.type 必须等于流水 type，不等就跳过这条、继续往下匹配。
 * 跳过而不是直接返回 null，是为了保住"多条规则里第一条方向不对、后面那条方向
 * 对"的场景——跨方向只该让**这一条**规则失效，不该让整条流水失去分类。
 *
 * 判据写成 `r.categoryType !== txType` 而不是"相等才放行"，是顺带把一类坏数据
 * 也挡在外面：categoryId 指向已不存在的分类时 categoryType 是 null，
 * 而 categories.type 只有 expense/income 两种，null 永远不等于任何流水方向。
 * 那种规则挂上去只会写出一个查无此分类的 categoryId，留空比写错好。
 *
 * 附带一个正确后果：type 不在 {expense, income} 里的流水（如 bill 解析器标出的
 * excluded，bill/importer.ts 会先滤掉，正常到不了这里）现在一律不分类——
 * 它本来就不是收支，挂支出/收入分类都是错的。
 */
function makeRuleMatcher(rules: RuleRow[]): RuleMatcher {
  if (rules.length === 0) return () => null as number | null;
  return (merchant: string, txType: TxDirection, remark?: string | null): number | null => {
    for (const r of rules) {
      // 方向闸门放最前面：最便宜的一条判断，且不含关键字的脏规则在这里就被挡掉
      if (r.categoryType !== txType) continue;
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
