/**
 * REST 行 → 前端实体 的归一化 helper（accounts / dashboard 共用）
 * ---------------------------------------------------------------
 * core 的 REST 路由直接 `SELECT *` 后 res.json，因此返回的是**原始 SQLite 行**，
 * 与前端 `@/db` 的接口类型存在三处差异，必须归一化后才能交给 calculations 等纯函数：
 *
 *   1. tagIds            TEXT(JSON)  → number[]   （"null"/""/脏数据 → []）
 *   2. includeInNetAsset INTEGER(0/1) → boolean
 *      includeInAsset    INTEGER(0/1) → boolean
 *   3. remark / spaceId  NULL → undefined
 *
 * ⚠️ 第 2 条不是可选的美化：dashboard/calculations.ts 用的是**严格比较**
 *    `t.includeInAsset === false`，而 `0 === false` 为 false，不归一化会让
 *    "不计资产" 的收入被错误计入本月收入。
 *
 * 本文件不含任何 fetch，纯类型转换，便于测试。
 */
import type { Account, Transaction } from '@/db';

/** REST 返回的账户行（未归一化） */
export type RestAccount = Omit<Account, 'remark' | 'tagIds' | 'includeInNetAsset' | 'spaceId'> & {
  remark?: string | null;
  tagIds?: number[] | string | null;
  includeInNetAsset?: number | boolean | null;
  spaceId?: number | null;
};

/** REST 返回的流水行（未归一化） */
export type RestTransaction = Omit<
  Transaction,
  'remark' | 'tagIds' | 'includeInAsset' | 'spaceId'
> & {
  remark?: string | null;
  tagIds?: number[] | string | null;
  includeInAsset?: number | boolean | null;
  spaceId?: number | null;
};

/** tagIds 归一化：数组原样、数字数组文本 → number[]，其余一律 [] */
export function parseTagIds(raw: unknown): number[] {
  if (Array.isArray(raw)) {
    return raw.filter((x): x is number => typeof x === 'number');
  }
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null') return [];
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    /* 脏数据按无标签处理 */
    return [];
  }
}

/** 0/1 INTEGER → boolean（undefined 视为 false，与 SQLite DEFAULT 1 的语义一致由调用方保证） */
function toBool(raw: number | boolean | null | undefined, fallback = false): boolean {
  if (raw === undefined || raw === null) return fallback;
  return !!raw;
}

/** 单个账户行 → Account */
export function toAccount(row: RestAccount): Account {
  return {
    ...row,
    remark: row.remark ?? undefined,
    tagIds: parseTagIds(row.tagIds),
    includeInNetAsset: toBool(row.includeInNetAsset, true),
    spaceId: row.spaceId ?? undefined,
  };
}

/** 账户列表 → Account[]（null 安全） */
export function toAccounts(rows: RestAccount[] | null | undefined): Account[] {
  return (rows ?? []).map(toAccount);
}

/** 单条流水行 → Transaction */
export function toTransaction(row: RestTransaction): Transaction {
  return {
    ...row,
    remark: row.remark ?? undefined,
    tagIds: parseTagIds(row.tagIds),
    includeInAsset: toBool(row.includeInAsset, true),
    spaceId: row.spaceId ?? undefined,
  };
}

/** 流水列表 → Transaction[]（null 安全） */
export function toTransactions(rows: RestTransaction[] | null | undefined): Transaction[] {
  return (rows ?? []).map(toTransaction);
}
