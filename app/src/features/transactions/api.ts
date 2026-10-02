/**
 * 交易模块的 REST 适配层
 * ---------------------------------------------------------------
 * 只做两件事：把 core 返回的 SQLite 行形状抹平成前端 @/db 的类型，
 * 以及补一个 DELETE 助手（core 的 DELETE 返回 204 空响应体）。
 * 不含业务逻辑——筛选/聚合仍由 balance.ts 负责。
 */
import type { Transaction } from '@/db';

/**
 * core 直接返回的 transactions 行。与前端 Transaction 的差异：
 *  - 可空外键（categoryId / toAccountId / merchantId / remark）在 SQLite 里是 NULL
 *  - tagIds 存的是 JSON 文本，includeInAsset 存的是 0/1
 */
export type RestTransaction = Omit<
  Transaction,
  'categoryId' | 'toAccountId' | 'merchantId' | 'remark' | 'tagIds' | 'includeInAsset'
> & {
  categoryId?: number | null;
  toAccountId?: number | null;
  merchantId?: number | null;
  remark?: string | null;
  tagIds?: string | number[] | null;
  includeInAsset?: number | boolean | null;
};

/** tagIds 可能是 '[1,2]' / '[]' / null / 已是数组，统统收敛成 number[]。 */
function parseTagIds(raw: RestTransaction['tagIds']): number[] | undefined {
  if (raw == null) return undefined;
  if (Array.isArray(raw)) return raw.length > 0 ? raw : undefined;
  if (typeof raw === 'string') {
    if (raw === '') return undefined;
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        const nums = arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
        return nums.length > 0 ? nums : undefined;
      }
    } catch {
      /* 脏数据按无标签处理 */
    }
  }
  return undefined;
}

/** SQLite 行 → 前端 Transaction（供列表渲染 / balance.ts 纯逻辑复用）。 */
export function toTransaction(row: RestTransaction): Transaction {
  return {
    ...row,
    categoryId: row.categoryId ?? undefined,
    toAccountId: row.toAccountId ?? undefined,
    merchantId: row.merchantId ?? undefined,
    remark: row.remark ?? undefined,
    tagIds: parseTagIds(row.tagIds),
    includeInAsset: row.includeInAsset ? true : false,
  };
}

/**
 * DELETE 助手。
 * core 的 DELETE 一律返回 204 空响应体，而 apiFetch 假定响应是 JSON，
 * 成功路径反而会在 r.json() 上抛错，因此删除操作不能走 apiFetch。
 */
export async function apiDelete(url: string): Promise<void> {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}
