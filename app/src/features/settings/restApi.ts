/**
 * 设置模块 REST 数据访问层（替代 db.* 的 Dexie 直连）。
 *
 * 与 reports/api.ts 同源的约定：
 *  - core (SQLite) 用 INTEGER 0/1 存布尔字段，REST 原样返回数字，读出时归一化成 boolean。
 *  - core 的 DELETE 端点统一返回 204 空体，不能用 apiFetch（内部 r.json() 会抛），
 *    因此删除一律走 restDelete()。
 *  - core 的 GET /api/kv/:key 对不存在的键返回 404（而非空值），
 *    所以 kv 读取单独用 kvGet()（404 → undefined）与 useKv()，而不是 useApi。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/hooks/useApi';
import type {
  AiModel,
  Category,
  Merchant,
  Space,
  Tag,
  TxRule,
} from '@/db';

/* ───────────────────── 通用 REST 小工具 ───────────────────── */

/** DELETE 端点返回 204 空体 / 404 幂等，统一在这里吞掉空响应。 */
export async function restDelete(url: string): Promise<void> {
  const r = await fetch(url, { method: 'DELETE' });
  if (r.status === 204 || r.status === 404) return;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

/** SQLite INTEGER 0/1 ↔ boolean。null / undefined 视为 false。 */
export function bit(value: number | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value != null;
}

/* ───────────────────── /api/kv 封装 ───────────────────── */

export interface KvEnvelope<T> {
  key: string;
  value: T;
}

/**
 * 读一个 kv 键。core 对不存在的键返回 404，这里归一为 undefined（= 未设置），
 * 只把 4xx/5xx 之外的真实故障抛给调用方。
 */
export async function kvGet<T>(key: string): Promise<T | undefined> {
  const r = await fetch(`/api/kv/${encodeURIComponent(key)}`);
  if (r.status === 404) return undefined;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const row = (await r.json()) as KvEnvelope<T>;
  return row.value;
}

export function kvPut<T>(key: string, value: T): Promise<KvEnvelope<T>> {
  return apiFetch<KvEnvelope<T>>(
    `/api/kv/${encodeURIComponent(key)}`,
    'PUT',
    { value },
  );
}

export function kvDelete(key: string): Promise<void> {
  return restDelete(`/api/kv/${encodeURIComponent(key)}`);
}

export interface UseKvResult<T> {
  /** undefined = 仍未加载完成；null = 键不存在；其余为实际值 */
  value: T | null | undefined;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/**
 * 读 kv 的 hook。
 * useApi 对 404 会置 error，而 kv「键不存在」是正常业务状态，
 * 因此这里单独实现：undefined 加载中 / null 未设置 / T 实际值。
 */
export function useKv<T>(key: string): UseKvResult<T> {
  const [value, setValue] = useState<T | null | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    kvGet<T>(key)
      .then((v) => {
        if (cancelled) return;
        setValue(v === undefined ? null : v);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [key, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { value, loading, error, refetch };
}

/* ───────────────────── 行类型（REST 出参） ───────────────────── */

export interface RestTagRow {
  id: number;
  name: string;
  color?: string | null;
}

export interface RestMerchantRow {
  id: number;
  name: string;
  remark?: string | null;
}

export interface RestCategoryRow {
  id: number;
  name: string;
  group: string;
  type: string;
  icon?: string | null;
  color?: string | null;
}

export interface RestRuleRow {
  id: number;
  keyword: string;
  matchField: string;
  categoryId: number;
  priority: number;
  enabled: number | boolean;
  createdAt: number;
}

export interface RestAiModelRow {
  id: number;
  name: string;
  model: string;
  endpoint: string;
  /** 默认脱敏为 null；带 hideApiKey=0 才返回明文 */
  apiKey?: string | null;
  hasApiKey?: boolean;
}

export interface RestSpaceRow {
  id: number;
  name: string;
  createdAt: number;
  /** core 附带的各表记录数统计 */
  counts?: Record<string, number>;
}

/* ───────────────────── 行 → @/db 实体 ───────────────────── */

function opt<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

export function toTags(rows: RestTagRow[]): Tag[] {
  return rows.map((r) => ({ id: r.id, name: r.name, color: opt(r.color) }));
}

export function toMerchants(rows: RestMerchantRow[]): Merchant[] {
  return rows.map((r) => ({ id: r.id, name: r.name, remark: opt(r.remark) }));
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

export function toRules(rows: RestRuleRow[]): TxRule[] {
  return rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    matchField: r.matchField as TxRule['matchField'],
    categoryId: r.categoryId,
    priority: r.priority,
    // SQLite INTEGER 0/1 → boolean
    enabled: bit(r.enabled),
    createdAt: r.createdAt,
  }));
}

export function toAiModels(rows: RestAiModelRow[]): AiModel[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    model: r.model,
    endpoint: r.endpoint,
    apiKey: opt(r.apiKey),
  }));
}

export function toSpaces(rows: RestSpaceRow[]): Space[] {
  return rows.map((r) => ({ id: r.id, name: r.name, createdAt: r.createdAt }));
}
