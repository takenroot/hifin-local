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
import { resolveAccountName, ACCOUNT_NAMES, type BillPlatform } from '../bill/account-map.js';

/**
 * 账户名 → 账户 id 的分流表。
 *
 * 由调用方（REST 层 / CLI）从 accounts 表读出来传进来，导入链路**不自己查
 * accounts 表**：一是为了让"用户建了哪些账户"这件事只有一处决定，二是
 * 让纯逻辑（分流、判重、分类）能在没有库的单测里被完整测到。
 */
export type AccountMap = Readonly<Record<string, number>>;

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
  /**
   * 账户名 → id 的分流表（可选，**不传即完全向后兼容**）。
   *
   * 传了之后两件事会变：
   *   1. 普通收支行按 paymentMethod 解析出账户名再查 id，落到对应账户，
   *      查不到（或 paymentMethod 缺失）就退回调用方给的兜底 accountId；
   *   2. type='transfer' 的行按 fromAccountName/toAccountName 落
   *      accountId/toAccountId，并联动两边余额。
   *
   * 不传时 transfer 行按"没有对端账户"处理：只落转账出、不联动，
   * 保证改造前后同一份账单导入出的行数与余额完全一致。
   */
  accountMap?: AccountMap;
  /**
   * 分流时的兜底账户 id（默认取 accountId 入参）。
   * 账单渠道认不出、或分流表里没有对应账户名时用它，绝不因为"找不到账户"
   * 就丢行或抛异常——丢行是静默的数据丢失，抛异常是整批导入失败，
   * 两者都比"记到兜底账户、并在结果里报告"更糟。
   */
  fallbackAccountId?: number;
}

export interface ImportResult {
  imported: number;
  skipped: number;
  /**
   * 划转因账户名查不到而被降级到兜底账户的统计（账户名 → 笔数）。
   * 钱记对了、归属可能错了，所以要让调用方能报给用户。非空才出现。
   */
  unmappedTransfers?: Record<string, number>;
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
  const accountMap = opts.accountMap;
  const fallbackAccountId = opts.fallbackAccountId ?? accountId;

  /**
   * 分流开关：只有调用方给了分流表才按渠道落账户。
   *
   * 没给时**每一行都落 accountId**（改造前的行为），划转也只落转账出侧、
   * 不联动对端。这样"同一个库、没启用多账户的用户"导入结果与改造前逐字节一致。
   */
  const useAccountMap = !!accountMap;

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

  /**
   * 插入语句。带上 toAccountId —— 划转行的"钱到哪儿去了"就靠这一列，
   * 少了它转账只剩一条"少了钱"的流水，对端余额永远不会涨。
   */
  const insert = db.prepare(`
    INSERT INTO transactions
      (type, name, amount, date, accountId, toAccountId, categoryId, remark, includeInAsset, spaceId, createdAt,
       source, externalId, paymentMethod, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
   *
   * 划转不分类：账户之间搬钱没有"消费场景"，给它挂一个支出分类会让
   * 统计凭空多出一笔支出（收支方向闸门挡不住，因为这里的 type 可能是 transfer）。
   */
  function findBillCategoryId(it: ParsedTx): number | null {
    if (!applyBillCategories) return null;
    if (it.type !== 'expense' && it.type !== 'income') return null;
    if (!it.platform || !it.billCategory) return null;
    const name = resolveBillCategory(it.platform, it.billCategory, it.type);
    if (!name) return null;
    const row = categoryByName.get(name);
    if (!row) return null;
    if (row.type !== it.type) return null;
    return row.id;
  }

  /**
   * 账户名 → id。分流表里没有、或 id 不可用时返回 null，由调用点决定降级。
   *
   * 刻意不"查不到就返回兜底"：划转的两端各有一次查找，转出侧和转入侧可能
   * 一个查得到一个查不到，混在一次调用里就分不清该报告谁、降级谁。
   */
  function lookupAccount(name: string | null | undefined): number | null {
    if (!name || !accountMap) return null;
    const id = accountMap[name];
    return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : null;
  }

  /**
   * 划转的"账户不存在"降级统计。
   *
   * 钱照记（记到兜底账户上，总额是对的），但归属可能不是用户以为的那个账户，
   * 所以把账户名与笔数攒起来交给调用方报给用户，而不是静默落库。
   */
  const unmapped: Record<string, number> = {};

  function noteUnmapped(name: string): void {
    unmapped[name] = (unmapped[name] ?? 0) + 1;
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

      /**
       * 这一行最终落哪个（转出侧）账户。
       *
       * 分流开启时：划转看 fromAccountName，收支看 paymentMethod 解析出的账户名。
       * 任何一个环节查不到账户 id 就退回兜底账户——**绝不因为查不到就不记**。
       */
      let accountIdForRow = accountId;
      let toAccountIdForRow: number | null = null;
      /**
       * 自转：钱在同一个账户里转了一圈，净额必须是 0。
       *
       * 判据取**名字**而不是 id：归并后"零钱"与"零钱通"是同一个账户名，
       * 名字相同就已经是自转了，不该等它们各自解析成 id 再比。
       */
      let selfTransfer = false;

      if (useAccountMap) {
        if (it.type === 'transfer') {
          selfTransfer =
            !!it.fromAccountName && !!it.toAccountName && it.fromAccountName === it.toAccountName;

          const fromId = lookupAccount(it.fromAccountName);
          accountIdForRow = fromId ?? fallbackAccountId;
          if (!fromId) noteUnmapped(it.fromAccountName ?? ACCOUNT_NAMES.fallback);

          const toId = lookupAccount(it.toAccountName);
          if (toId !== null && toId !== accountIdForRow && !selfTransfer) {
            toAccountIdForRow = toId;
          } else if (toId === null) {
            /**
             * 对端查不到时**不写 toAccountId**：写个等于转出侧的 id 会让这条划转
             * 变成"自己转自己"，余额加了又减，看着对其实是在掩盖降级。
             */
            noteUnmapped(it.toAccountName ?? ACCOUNT_NAMES.fallback);
          }
        } else {
          const name = resolveAccountName(paymentMethod, it.platform as BillPlatform | undefined);
          const id = lookupAccount(name);
          accountIdForRow = id ?? fallbackAccountId;
          if (!id) noteUnmapped(name);
        }
      }

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
         *
         * 启发式用分流后的 accountId：同一笔消费落在哪个账户是分流决定的，
         * 拿分流前的 id 去比会把"其实同一个账户"的重复行漏判掉。
         */
        const dup = externalId
          ? (dupByExternalId.get(source, externalId) as unknown)
          : (dupCheck.get(accountIdForRow, it.amount, it.date, it.merchant) as unknown);
        if (dup) {
          skipped++;
          continue;
        }
      }
      // 分类优先级：规则引擎 > 账单自带分类映射 > null（留空）
      // 方向由 it.type 带进规则引擎：闸门要求规则的 categories.type 与流水方向一致
      // 划转不算收支，不分类：给一笔转账挂消费分类会让统计凭空多出一笔支出
      const categoryId =
        it.type === 'transfer' ? null : findCategory(it.merchant, it.type, remark) ?? findBillCategoryId(it);
      try {
        insert.run(
          it.type,
          it.merchant,
          it.amount,
          it.date,
          accountIdForRow,
          toAccountIdForRow,
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
      /**
       * 转出侧余额。划转且两端是同一个账户时净额为 0（钱在账户内部转了一圈），
       * 直接减会凭空扣掉一笔、后续又没人加回来。
       */
      const delta = selfTransfer ? 0 : it.type === 'income' ? it.amount : -it.amount;
      updateBalance.run(delta, now, accountIdForRow);

      /**
       * 划转的对端：钱要真的到账，只减不加就等于凭空销毁了这笔钱。
       *
       * 口径与 routes/transactions.ts 的 POST 落库一致（转出侧 -amount、
       * 转入侧 +amount），且**只在 toAccountId 存在时**联动：
       *   - 没分流（向后兼容路径）→ 对端是未知的，只能减，不能瞎加；
       *   - 对端账户缺失（降级）→ 已经记进 unmapped 由调用方报告，
       *     这时再加钱到兜底账户会凭空增记；
       *   - 自转 → 上面 delta 已经是 0，这里也绝不能再加一次。
       */
      if (toAccountIdForRow !== null) {
        updateBalance.run(it.amount, now, toAccountIdForRow);
      }
      imported++;
    }
  });

  tx(parsed);

  return {
    imported,
    skipped,
    ...(Object.keys(unmapped).length > 0 ? { unmappedTransfers: unmapped } : {}),
  };
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
