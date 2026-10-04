/**
 * 账户年收益率「一月催填」调度器
 * -----------------------------------------------------------------
 * 业务背景：用户的闲钱主要躺在零钱通 / 余额宝这类货币基金里，一年到头也就看
 * 一次"去年到底赚了多少"。所以每年 1 月提醒一次，把上一年的**实际收益金额**补录进来，
 * 形成 (账户 × 年份) 的历史序列。
 *
 * 记的是金额而不是年收益率：这些账户的余额天天在变，"余额 × 收益率"推出来的
 * 预估数没有参考价值，用户只想知道"去年那笔钱实际赚了多少块"。
 *
 * 三个动作，边界都必须守住，否则会变成打扰：
 *   1. 1 月内：对**缺上一年收益记录**的资产类账户去重建一条 yield-reminder 通知
 *   2. 任意时刻：记录已经补上的 → 对应通知立刻 resolved（不等到下次调度）
 *   3. 2 月 1 日起：还是 pending 的 → 标记 expired，从此不再出现在待办里
 *
 * 时间全部从入参 now 注入，不读系统时钟——这样"12/31 不触发 / 1/1 触发 /
 * 2/1 过期"这些边界才在测试里可复现。
 */

import type Database from 'better-sqlite3';
import {
  createNotification,
  expireNotification,
  listNotifications,
  parseNotificationPayload,
  resolveNotification,
} from '../notifications/store.js';
import type { NotificationRow } from '../db/schema.js';

/** 年度收益催填通知的 type（契约里的 kind/category） */
export const YIELD_REMINDER_TYPE = 'yield-reminder';

/** 催填窗口的月份：1 月 = 0（Date#getMonth 从 0 开始） */
export const REMINDER_MONTH = 0;

/**
 * 参与催填的账户类型。
 * 只取"会自己产生年度收益"的账户：invest / fund / other。
 * 刻意**不含**：
 *   - credit / debt —— 负债账户谈收益没有意义（设计约定里它们恒为红色负值）
 *   - asset（公积金/社保卡这类不能变现的账户）、social —— 不产生投资收益
 * 另外还要求 includeInNetAsset = 1：用户自己排除掉的账户不该被催。
 */
export const YIELD_ACCOUNT_TYPES = ['invest', 'fund', 'other'] as const;

/**
 * 窗口关闭的月份：2 月 = 1。
 * 判据是 `month >= 2月`（而不是 `month === 2月`）：催填通知的 target year
 * 恒为「创建那年 - 1」，所以从 2 月起它就永远属于过去。
 * 服务器 2 月没开机、12 月才第一次跑时，靠这条兜底把陈年 pending 收成 expired，
 * 而不是让它在待办里挂一年。
 */
const EXPIRY_MONTH = 1;

/** 催填通知的业务载荷 */
export interface YieldReminderPayload {
  accountId: number;
  year: number;
}

/** 一条"该填还没填"的记录 */
export interface MissingYield {
  accountId: number;
  accountName: string;
  /** 要补的年份 = now 所在年份 - 1 */
  year: number;
}

/** 一次 ensureYieldReminders 的结果，方便调用方打日志、测试断言 */
export interface YieldReminderRun {
  /** 本次新建的通知条数 */
  created: number;
  /** 因记录已补而自动解决的通知条数 */
  resolved: number;
  /** 因窗口过期而标记的通知条数 */
  expired: number;
  /** 当前窗口内缺记录（或窗口外为 []）的账户清单 */
  missing: MissingYield[];
}

/** 要补的年份：今年 1 月补的是"去年" */
export function reminderYear(now: Date): number {
  return now.getFullYear() - 1;
}

/** 是否处于催填窗口（仅 1 月） */
export function inReminderWindow(now: Date): boolean {
  return now.getMonth() === REMINDER_MONTH;
}

/** 某账户某年是否已填收益（唯一的"是否已填"判据，REST 写入后立即生效） */
export function hasYieldRecord(db: Database.Database, accountId: number, year: number): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM accountYields WHERE accountId = ? AND year = ?')
    .get(accountId, year);
  return row !== undefined;
}

/**
 * 找出"该填上一年收益金额却还没填"的资产类账户。
 *
 * 纯函数：不写库；`now` 完全由调用方注入。
 * 窗口外（getMonth() !== 0）一律返回空数组——12 月不该催，2 月之后也不该再催。
 */
export function findMissingYields(db: Database.Database, now: Date): MissingYield[] {
  if (!inReminderWindow(now)) return [];

  const year = reminderYear(now);
  const placeholders = YIELD_ACCOUNT_TYPES.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT a.id AS accountId, a.name AS accountName
         FROM accounts a
        WHERE a.type IN (${placeholders})
          AND a.includeInNetAsset = 1
          AND NOT EXISTS (
                SELECT 1 FROM accountYields y
                 WHERE y.accountId = a.id AND y.year = ?
              )
        ORDER BY a.id ASC`,
    )
    .all(...YIELD_ACCOUNT_TYPES, year) as Array<{ accountId: number; accountName: string }>;

  return rows.map((r) => ({ accountId: r.accountId, accountName: r.accountName, year }));
}

/** 读出所有 yield-reminder 通知，并把 payload 解析成结构化的 {accountId, year} */
function listYieldReminders(
  db: Database.Database,
): Array<{ id: number; accountId: number | null; year: number | null; status: string }> {
  const rows = listNotifications(db, { type: YIELD_REMINDER_TYPE }) as NotificationRow[];
  const out: Array<{ id: number; accountId: number | null; year: number | null; status: string }> = [];
  for (const row of rows) {
    const payload = parseNotificationPayload(row) as YieldReminderPayload | null;
    const accountId = Number(payload?.accountId);
    const year = Number(payload?.year);
    out.push({
      id: row.id as number,
      accountId: Number.isFinite(accountId) ? accountId : null,
      year: Number.isFinite(year) ? year : null,
      status: row.status,
    });
  }
  return out;
}

/** (accountId, year) 拼成去重键 */
function dedupeKey(accountId: number, year: number): string {
  return `${accountId}:${year}`;
}

/**
 * 对应记录已补上的催填通知 → resolved。
 * 任何月份都跑：用户在 1 月填、2 月甚至 3 月才想起来补，都应该立刻消掉提醒。
 * 返回被解决的通知 id，供过期分支排除——同一轮里刚 resolved 的行不能又被标成 expired。
 */
function resolveFilledReminders(
  db: Database.Database,
  reminders: ReturnType<typeof listYieldReminders>,
): Set<number> {
  const resolvedIds = new Set<number>();
  for (const r of reminders) {
    if (r.status !== 'pending' || r.accountId === null || r.year === null) continue;
    if (!hasYieldRecord(db, r.accountId, r.year)) continue;
    resolveNotification(db, r.id);
    resolvedIds.add(r.id);
  }
  return resolvedIds;
}

/**
 * 催填主流程。幂等：同一个 now 跑 N 次与跑 1 次结果一致。
 *
 * 1 月内按 (accountId, year) 去重建通知——**任意状态**的通知都算"已提醒过"：
 * 用户主动 dismiss 过、或去年 2 月已 expired 的，今年不该再被同一件事追着跑。
 *
 * 整段包在一个事务里：这是一次"对账"，要么全做完要么不做。
 * 半途崩溃若留下"10 个账户只提醒了 3 个"的状态，虽然下一轮能自愈，
 * 但中间那 21 小时用户看到的提醒列表是残缺的，没必要冒这个险。
 */
export function ensureYieldReminders(db: Database.Database, now: Date): YieldReminderRun {
  return db.transaction((): YieldReminderRun => {
    // 同一轮里"建"和"改"必须看到同一份快照，所以先读一次再算
    const existing = listYieldReminders(db);
    const missing = findMissingYields(db, now);

    const resolvedIds = resolveFilledReminders(db, existing);

    let created = 0;
    if (inReminderWindow(now)) {
      const notified = new Set(
        existing
          .filter((r) => r.accountId !== null && r.year !== null)
          .map((r) => dedupeKey(r.accountId as number, r.year as number)),
      );
      for (const m of missing) {
        const key = dedupeKey(m.accountId, m.year);
        if (notified.has(key)) continue;
        notified.add(key);
        createNotification(db, {
          type: YIELD_REMINDER_TYPE,
          title: `记一下「${m.accountName}」${m.year} 年的收益`,
          message: `${m.accountName}（#${m.accountId}）还没有 ${m.year} 年的收益记录，填一下当年实际赚了多少钱。`,
          payload: { accountId: m.accountId, year: m.year } satisfies YieldReminderPayload,
        });
        created += 1;
      }
    }

    // 窗口关闭（2 月 1 日及以后）且目标年份已成过去 → 标记过期，不再打扰。
    // 只动 pending：dismissed / resolved / expired 都已经是终态；
    // 刚在这一轮被 resolve 掉的（resolvedIds）也必须排除——
    // 否则"用户补填了"会被同一轮里过期的另一个分支覆盖成 expired，把语义搅浑。
    let expired = 0;
    if (now.getMonth() >= EXPIRY_MONTH) {
      const currentYear = now.getFullYear();
      for (const r of existing) {
        if (r.status !== 'pending' || r.year === null) continue;
        if (resolvedIds.has(r.id)) continue;
        if (r.year >= currentYear) continue;
        expireNotification(db, r.id);
        expired += 1;
      }
    }

    return { created, resolved: resolvedIds.size, expired, missing };
  })();
}

/**
 * 补填某账户某年收益金额后，立刻消掉对应的催填通知（REST 的 PUT 端点调用）。
 * 返回被解决的通知条数；没有待办通知时返回 0。
 *
 * 放在这里而不是路由里，是为了让"写入即消提醒"这条不变量只有一处实现，
 * 调度器里的对账逻辑和 REST 走的是同一个函数。
 */
export function resolveYieldReminders(
  db: Database.Database,
  accountId: number,
  year: number,
): number {
  const key = dedupeKey(accountId, year);
  let n = 0;
  for (const r of listYieldReminders(db)) {
    if (r.status !== 'pending' || r.accountId === null || r.year === null) continue;
    if (dedupeKey(r.accountId, r.year) !== key) continue;
    resolveNotification(db, r.id);
    n += 1;
  }
  return n;
}
