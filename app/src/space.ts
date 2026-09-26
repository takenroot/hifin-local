/**
 * 多空间共享 helper。
 *
 * 设计要点：
 *  - spaceId === 0 在前端语义上是"全部空间"，过滤返回全部；
 *  - 任意记录若缺 spaceId 字段，按 DEFAULT_SPACE_ID 处理（兼容老数据）；
 *  - 这两个函数是纯函数，便于测试。
 */

import { DEFAULT_SPACE_ID } from '@/db';

export const ALL_SPACES_ID = 0;

/** 行带可选 spaceId */
export interface SpaceAware {
  spaceId?: number;
}

/**
 * 判断某行是否属于指定空间 sid。
 *  - sid === 0 ⇒ 全部空间，返回 true
 *  - 否则：行无 spaceId ⇒ 视作默认空间 DEFAULT_SPACE_ID
 */
export function belongsToSpace(row: SpaceAware, sid: number): boolean {
  if (sid === ALL_SPACES_ID) return true;
  const effective = row.spaceId ?? DEFAULT_SPACE_ID;
  return effective === sid;
}

/**
 * 按空间过滤（返回新数组）。
 * 用法：const rows = useLiveQuery(() => filterBySpace(myRows, spaceId), [spaceId]);
 */
export function filterBySpace<T extends SpaceAware>(rows: T[], sid: number): T[] {
  if (sid === ALL_SPACES_ID) return rows;
  return rows.filter((r) => belongsToSpace(r, sid));
}