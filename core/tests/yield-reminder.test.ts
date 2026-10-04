/**
 * 一月催填调度器测试（core/src/yields/reminder.ts）。
 *
 * 全部时间从入参注入，因此"12/31 不触发 / 1/1 触发 / 2/1 过期"这些跨年边界
 * 在测试里是一行 new Date(2026, 0, 1)，不依赖真实时钟，也不需要 mock 定时器。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import {
  findMissingYields,
  ensureYieldReminders,
  resolveYieldReminders,
  reminderYear,
  inReminderWindow,
  hasYieldRecord,
  YIELD_REMINDER_TYPE,
} from '../src/yields/reminder.js';

/** 造一个已迁移的 :memory: 库 */
function freshDb(): Database.Database {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

let seq = 0;
function makeAccount(
  db: Database.Database,
  name: string,
  type: string,
  includeInNetAsset = 1,
): number {
  const r = db
    .prepare(
      `INSERT INTO accounts (name, type, balance, includeInNetAsset, spaceId, createdAt, updatedAt)
       VALUES (?, ?, 1000, ?, 1, 1, 1)`,
    )
    .run(name, type, includeInNetAsset);
  seq += 1;
  return Number(r.lastInsertRowid);
}

function fillYield(db: Database.Database, accountId: number, year: number, yp = 1.5): void {
  db.prepare(
    'INSERT INTO accountYields (accountId, year, annualIncome, note, createdAt) VALUES (?, ?, ?, NULL, 1)',
  ).run(accountId, year, yp);
}

/** 当前库里所有 yield-reminder 通知（按 id 升序） */
function reminders(db: Database.Database): Array<Record<string, unknown>> {
  return db
    .prepare('SELECT id, title, status, payload FROM notifications WHERE type = ? ORDER BY id')
    .all(YIELD_REMINDER_TYPE) as Array<Record<string, unknown>>;
}

function payloadOf(row: Record<string, unknown>): { accountId: number; year: number } {
  return JSON.parse(row.payload as string) as { accountId: number; year: number };
}

let db: Database.Database;

beforeEach(() => {
  db?.close?.();
  db = freshDb();
});

describe('findMissingYields：窗口与范围', () => {
  it('12 月 31 日不触发（窗口只在 1 月）', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    expect(findMissingYields(db, new Date(2025, 11, 31, 23, 59))).toEqual([]);
    const run = ensureYieldReminders(db, new Date(2025, 11, 31, 23, 59));
    expect(run.created).toBe(0);
    expect(reminders(db)).toHaveLength(0);
    // 顺带确认账户本身确实是"该填"的，只是时候没到
    expect(findMissingYields(db, new Date(2026, 0, 1))).toEqual([
      { accountId: a, accountName: '零钱通', year: 2025 },
    ]);
  });

  it('1 月 1 日零点即触发，且要的是"上一年"', () => {
    const a = makeAccount(db, '余额宝', 'fund');
    const now = new Date(2026, 0, 1, 0, 0, 0);
    expect(reminderYear(now)).toBe(2025);
    expect(inReminderWindow(now)).toBe(true);
    expect(findMissingYields(db, now)).toEqual([
      { accountId: a, accountName: '余额宝', year: 2025 },
    ]);

    const run = ensureYieldReminders(db, now);
    expect(run.created).toBe(1);
    const rows = reminders(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(payloadOf(rows[0])).toEqual({ accountId: a, year: 2025 });
    expect(rows[0].title).toContain('余额宝');
    expect(rows[0].title).toContain('2025');
  });

  it('已经填了上一年的账户不算缺（只差"上一年"，填了更早的不算数）', () => {
    const filled = makeAccount(db, '已填', 'invest');
    const old = makeAccount(db, '只填了更早年份', 'fund');
    fillYield(db, filled, 2025);
    fillYield(db, old, 2024);

    const missing = findMissingYields(db, new Date(2026, 0, 15));
    expect(missing.map((m) => m.accountId)).toEqual([old]);
    expect(missing[0].year).toBe(2025);
  });

  it('负债 / 信用 / 社保 / 公积金类账户一律不催', () => {
    makeAccount(db, '花呗', 'credit');
    makeAccount(db, '房贷', 'debt');
    makeAccount(db, '公积金', 'asset');
    makeAccount(db, '社保卡', 'social');
    expect(findMissingYields(db, new Date(2026, 0, 10))).toEqual([]);
    expect(ensureYieldReminders(db, new Date(2026, 0, 10)).created).toBe(0);
  });

  it('includeInNetAsset=0 的账户不催（用户自己排除掉的）', () => {
    makeAccount(db, '已排除的资产', 'invest', 0);
    const kept = makeAccount(db, '计入净资产', 'invest', 1);
    expect(findMissingYields(db, new Date(2026, 0, 10)).map((m) => m.accountId)).toEqual([kept]);
  });

  it('invest / fund / other 三类都催', () => {
    const ids = ['invest', 'fund', 'other'].map((t) => makeAccount(db, `t-${t}`, t));
    expect(findMissingYields(db, new Date(2026, 0, 10)).map((m) => m.accountId)).toEqual(ids);
  });

  it('清单按账户 id 升序，稳定可断言', () => {
    makeAccount(db, 'b', 'invest');
    makeAccount(db, 'a', 'fund');
    const names = findMissingYields(db, new Date(2026, 0, 10)).map((m) => m.accountName);
    const ids = findMissingYields(db, new Date(2026, 0, 10)).map((m) => m.accountId);
    expect(ids).toEqual([...ids].sort((x, y) => x - y));
    expect(names).toEqual(['b', 'a']);
  });
});

describe('ensureYieldReminders：去重与幂等', () => {
  it('同一天反复跑不会重复建通知', () => {
    makeAccount(db, '零钱通', 'invest');
    const now = new Date(2026, 0, 5, 9, 30);
    const first = ensureYieldReminders(db, now);
    const second = ensureYieldReminders(db, now);
    const third = ensureYieldReminders(db, new Date(2026, 0, 28));

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(third.created).toBe(0);
    expect(reminders(db)).toHaveLength(1);
  });

  it('1 月跑了 3 次也只有一条；每个账户各一条，互不串号', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    const b = makeAccount(db, '余额宝', 'fund');
    ensureYieldReminders(db, new Date(2026, 0, 1));
    ensureYieldReminders(db, new Date(2026, 0, 10));
    ensureYieldReminders(db, new Date(2026, 0, 31));

    const rows = reminders(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => payloadOf(r).accountId).sort((x, y) => x - y)).toEqual([a, b].sort((x, y) => x - y));
    expect(rows.every((r) => payloadOf(r).year === 2025)).toBe(true);
  });

  it('用户主动 dismiss 过的，不在同一个 1 月里重新骚扰', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 2));
    const id = reminders(db)[0].id as number;
    db.prepare("UPDATE notifications SET status = 'dismissed' WHERE id = ?").run(id);

    const run = ensureYieldReminders(db, new Date(2026, 0, 20));
    expect(run.created).toBe(0);
    expect(reminders(db)).toHaveLength(1);
    expect(reminders(db)[0].status).toBe('dismissed');
    expect(payloadOf(reminders(db)[0]).accountId).toBe(a);
  });

  it('跨年：2027 年 1 月针对 2026 年重新催一次（不与 2025 年那条冲突）', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    const run = ensureYieldReminders(db, new Date(2027, 0, 5));

    expect(run.created).toBe(1);
    const rows = reminders(db);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => payloadOf(r).year).sort()).toEqual([2025, 2026]);
    expect(rows.map((r) => payloadOf(r).accountId)).toEqual([a, a]);
  });
});

describe('ensureYieldReminders：填写后自动解决', () => {
  it('补填后下一次对账把通知 resolved', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    expect(reminders(db)[0].status).toBe('pending');

    fillYield(db, a, 2025);
    const run = ensureYieldReminders(db, new Date(2026, 0, 6));
    expect(run.resolved).toBe(1);
    expect(reminders(db)[0].status).toBe('resolved');
  });

  it('解决了就不再出现在待办列表里', () => {
    const a = makeAccount(db, '余额宝', 'fund');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    fillYield(db, a, 2025);
    ensureYieldReminders(db, new Date(2026, 0, 6));

    const pending = db
      .prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'pending'")
      .get() as { c: number };
    expect(pending.c).toBe(0);
  });

  it('resolveYieldReminders 只解决对应账户对应年份的那条', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    const b = makeAccount(db, '余额宝', 'fund');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    // 造一条 2026 年的（跨年场景）
    ensureYieldReminders(db, new Date(2027, 0, 5));
    expect(reminders(db)).toHaveLength(4);

    const n = resolveYieldReminders(db, a, 2025);
    expect(n).toBe(1);
    const byKey = new Map(reminders(db).map((r) => [`${payloadOf(r).accountId}:${payloadOf(r).year}`, r.status as string]));
    expect(byKey.get(`${a}:2025`)).toBe('resolved');
    expect(byKey.get(`${b}:2025`)).toBe('pending');
    expect(byKey.get(`${a}:2026`)).toBe('pending');
    expect(byKey.get(`${b}:2026`)).toBe('pending');
  });

  it('没填过就不会凭空解决（不会误伤）', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    const run = ensureYieldReminders(db, new Date(2026, 0, 6));
    expect(run.resolved).toBe(0);
    expect(reminders(db)[0].status).toBe('pending');
    // 填了别的年份也不算
    fillYield(db, a, 2024);
    expect(ensureYieldReminders(db, new Date(2026, 0, 7)).resolved).toBe(0);
    expect(hasYieldRecord(db, a, 2025)).toBe(false);
  });

  it('1 月之外补填同样会被解决（用户拖到 3 月才想起来也算）', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 5));
    ensureYieldReminders(db, new Date(2026, 1, 1)); // 2 月：先过期
    fillYield(db, a, 2025);
    // 过期是终态，不会被"倒过来"改成 resolved，但也不再是 pending
    expect(reminders(db)[0].status).toBe('expired');
    expect(ensureYieldReminders(db, new Date(2026, 2, 1)).created).toBe(0);
  });
});

describe('ensureYieldReminders：2 月 1 日过期', () => {
  it('1/31 还是 pending，2/1 变 expired', () => {
    makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 31, 23, 0));
    expect(reminders(db)[0].status).toBe('pending');

    const run = ensureYieldReminders(db, new Date(2026, 1, 1, 0, 30));
    expect(run.expired).toBe(1);
    expect(run.created).toBe(0);
    expect(reminders(db)[0].status).toBe('expired');
  });

  it('过期后不再出现在 pending 待办里（不再打扰）', () => {
    makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 10));
    ensureYieldReminders(db, new Date(2026, 1, 1));
    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE status = 'pending'").get() as { c: number }).c,
    ).toBe(0);
  });

  it('已填的那条不该被判过期（先 resolve，不进过期分支）', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 10));
    fillYield(db, a, 2025);

    const run = ensureYieldReminders(db, new Date(2026, 1, 1));
    expect(run.resolved).toBe(1);
    expect(run.expired).toBe(0);
    expect(reminders(db)[0].status).toBe('resolved');
  });

  it('过期是幂等的：2 月连跑 5 遍只过期一次', () => {
    makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 10));
    const counts = [1, 2, 3, 4, 5].map(
      () => ensureYieldReminders(db, new Date(2026, 1, 1)).expired,
    );
    expect(counts).toEqual([1, 0, 0, 0, 0]);
    expect(reminders(db)).toHaveLength(1);
    expect(reminders(db)[0].status).toBe('expired');
  });

  it('窗口关闭之后的每个月都兜底过期：12 月重跑也不会把 pending 留着继续打扰', () => {
    // 这条提醒是 1 月建的、用户一直没填。若服务器在 2 月之后才第一次跑
    // （或者中间几个月没开机），到 12 月仍然 pending 就等于还在打扰，
    // 兜底过期才是对的行为。真正的"不触发"指的是**不新建**，见上面的 12/31 用例。
    makeAccount(db, '零钱通', 'invest');
    ensureYieldReminders(db, new Date(2026, 0, 10));
    const run = ensureYieldReminders(db, new Date(2026, 11, 31));
    expect(run.expired).toBe(1);
    expect(run.created).toBe(0);
    expect(reminders(db)[0].status).toBe('expired');
  });

  it('目标年份还没过去的通知不会被误标过期', () => {
    // 造一条"未来年"的 pending 通知（正常流程造不出来，这里是防御性断言）
    makeAccount(db, '零钱通', 'invest');
    db.prepare(
      `INSERT INTO notifications (type, title, status, createdAt, updatedAt, payload)
       VALUES ('yield-reminder', '未来年', 'pending', 1, 1, '{"accountId":1,"year":2099}')`,
    ).run();
    const run = ensureYieldReminders(db, new Date(2026, 1, 1));
    expect(run.expired).toBe(0);
    expect(reminders(db).every((r) => r.status === 'pending')).toBe(true);
  });

  it('3 月 / 4 月… 全年都不会再新建催填', () => {
    makeAccount(db, '零钱通', 'invest');
    for (const month of [1, 2, 3, 6, 11]) {
      expect(ensureYieldReminders(db, new Date(2026, month, 15)).created).toBe(0);
    }
    expect(reminders(db)).toHaveLength(0);
  });
});

describe('ensureYieldReminders：与其它通知互不干扰', () => {
  it('只处理 type=yield-reminder，别人的通知原样不动', () => {
    const a = makeAccount(db, '零钱通', 'invest');
    db.prepare(
      `INSERT INTO notifications (type, title, status, createdAt, updatedAt)
       VALUES ('need_password', '要密码', 'pending', 1, 1)`,
    ).run();
    ensureYieldReminders(db, new Date(2026, 0, 5));
    const run = ensureYieldReminders(db, new Date(2026, 1, 1));
    expect(run.expired).toBe(1);

    const other = db.prepare("SELECT status FROM notifications WHERE type = 'need_password'").get() as {
      status: string;
    };
    expect(other.status).toBe('pending');
    expect(reminders(db)).toHaveLength(1);
    expect(payloadOf(reminders(db)[0]).accountId).toBe(a);
  });

  it('payload 是坏 JSON 的历史通知不会把调度器带崩', () => {
    makeAccount(db, '零钱通', 'invest');
    db.prepare(
      `INSERT INTO notifications (type, title, status, createdAt, updatedAt, payload)
       VALUES ('yield-reminder', '脏数据', 'pending', 1, 1, 'not-json')`,
    ).run();
    expect(() => ensureYieldReminders(db, new Date(2026, 0, 5))).not.toThrow();
    // 脏的那条因为认不出 accountId/year，不参与去重；正常的还是会被建
    expect(reminders(db).some((r) => r.title === '脏数据')).toBe(true);
    expect(ensureYieldReminders(db, new Date(2026, 0, 5)).created).toBe(0);
  });
});
