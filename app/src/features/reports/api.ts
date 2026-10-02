/**
 * 报表模块 REST 数据访问层（替代 db.reports / db.transactions 等 Dexie 调用）。
 *
 * 约定：
 *  - core (SQLite) 用 INTEGER 0/1 存布尔字段，REST 原样返回数字；
 *    本文件在读出时统一归一化成 @/db 中的 boolean，报表的 `=== false` 口径才正确。
 *  - core 未做 null → undefined 归一，UI 侧同样在这里处理。
 *  - core 的 reports.config 出参已是反序列化后的 JSON 值（不是字符串），
 *    这里统一 stringify 回 @/db 的 Report.config 形状，下游代码零改动。
 *  - 所有 DELETE 端点返回 204 空体，不能用 apiFetch（内部 r.json() 会抛），
 *    因此删除走本文件自带的 restDelete()。
 */
import { apiFetch } from '@/hooks/useApi';
import type {
  Account,
  Budget,
  Category,
  Report,
  Transaction,
} from '@/db';

/* ───────────────────── 原始行类型（REST 出参） ───────────────────── */

/** SQLite INTEGER 0/1 */
type Bit = number | boolean | null | undefined;

export interface RestReportRow {
  id: number;
  name: string;
  description?: string | null;
  template?: string | null;
  icon?: string | null;
  /** core 已反序列化为 JSON 值；脏数据时可能是字符串 */
  config?: unknown;
  createdAt: number;
}

export interface RestCategoryRow {
  id: number;
  name: string;
  group: string;
  type: string;
  icon?: string | null;
  color?: string | null;
}

export interface RestAccountRow {
  id: number;
  name: string;
  type: string;
  balance: number;
  remark?: string | null;
  tagIds?: string | null;
  includeInNetAsset: Bit;
  spaceId?: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RestTransactionRow {
  id: number;
  type: string;
  name: string;
  amount: number;
  date: number;
  categoryId?: number | null;
  accountId: number;
  toAccountId?: number | null;
  remark?: string | null;
  tagIds?: string | null;
  merchantId?: number | null;
  includeInAsset: Bit;
  spaceId?: number | null;
  createdAt: number;
}

export interface RestBudgetRow {
  id: number;
  name: string;
  categoryId?: number | null;
  amount: number;
  period: string;
  spaceId?: number | null;
  createdAt: number;
}

/* ───────────────────── 归一化小工具 ───────────────────── */

/** SQLite 0/1 ↔ boolean。null / undefined 视为 false。 */
function bit(value: Bit): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value != null;
}

function opt<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

/** tagIds 在 SQLite 里是 JSON number[] 文本，@/db 侧是 number[]。 */
function tagIds(raw: string | null | undefined): number[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as number[]) : undefined;
  } catch {
    return undefined;
  }
}

/* ───────────────────── 行 → @/db 实体 ───────────────────── */

export function toReport(row: RestReportRow): Report {
  let config: string | undefined;
  if (row.config !== undefined && row.config !== null && row.config !== '') {
    config = typeof row.config === 'string' ? row.config : JSON.stringify(row.config);
  }
  return {
    id: row.id,
    name: row.name,
    description: opt(row.description),
    template: opt(row.template),
    icon: opt(row.icon),
    config,
    createdAt: row.createdAt,
  };
}

export function toCategories(rows: RestCategoryRow[]): Category[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group,
    type: r.type as Category['type'],
    icon: opt(r.icon),
    color: opt(r.color),
  }));
}

export function toAccounts(rows: RestAccountRow[]): Account[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type as Account['type'],
    balance: r.balance,
    remark: opt(r.remark),
    tagIds: tagIds(r.tagIds),
    includeInNetAsset: bit(r.includeInNetAsset),
    spaceId: opt(r.spaceId),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export function toTransactions(rows: RestTransactionRow[]): Transaction[] {
  return rows.map((r) => ({
    id: r.id,
    type: r.type as Transaction['type'],
    name: r.name,
    amount: r.amount,
    date: r.date,
    categoryId: opt(r.categoryId),
    accountId: r.accountId,
    toAccountId: opt(r.toAccountId),
    remark: opt(r.remark),
    tagIds: tagIds(r.tagIds),
    merchantId: opt(r.merchantId),
    includeInAsset: bit(r.includeInAsset),
    spaceId: opt(r.spaceId),
    createdAt: r.createdAt,
  }));
}

export function toBudgets(rows: RestBudgetRow[]): Budget[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    categoryId: opt(r.categoryId),
    amount: r.amount,
    period: r.period as Budget['period'],
    spaceId: opt(r.spaceId),
    createdAt: r.createdAt,
  }));
}

/* ───────────────────── 报表 CRUD ───────────────────── */

export const REPORTS_API = '/api/reports';

/** 列表按创建时间升序（与迁移前的 orderBy('createdAt') 保持一致）。 */
export async function fetchReports(): Promise<Report[]> {
  const r = await fetch(REPORTS_API);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const rows = (await r.json()) as RestReportRow[];
  return rows
    .map(toReport)
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** 报表写入载荷（core 的 POST 由服务端写 createdAt，PUT 支持局部更新）。 */
export type ReportWritePayload = {
  name: string;
  description?: string;
  template?: string;
  icon?: string;
  config?: unknown;
};

export function createReport(payload: ReportWritePayload): Promise<RestReportRow> {
  return apiFetch<RestReportRow>(REPORTS_API, 'POST', payload);
}

export function updateReport(
  id: number,
  payload: ReportWritePayload,
): Promise<RestReportRow> {
  return apiFetch<RestReportRow>(`${REPORTS_API}/${id}`, 'PUT', payload);
}

/**
 * DELETE 端点统一返回 204 空体，不能用 apiFetch（内部会 r.json()）。
 * 404 视为幂等成功。
 */
export async function restDelete(url: string): Promise<void> {
  const r = await fetch(url, { method: 'DELETE' });
  if (r.status === 204 || r.status === 404) return;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

export function deleteReport(id: number): Promise<void> {
  return restDelete(`${REPORTS_API}/${id}`);
}
