/**
 * 交易规则引擎（纯函数，无副作用）
 * ---------------------------------------------------------------
 * 输入：一笔待分类的"流水草稿" + 当前所有规则
 * 输出：命中的 categoryId；若没有命中则返回 null
 *
 * 匹配规则：
 *   1. 仅考虑 enabled = true 的规则
 *   2. 按 priority 降序；同 priority 时按 createdAt 升序（先建先用）
 *   3. 取对应字段的字符串（name / merchant / remark），与 keyword 做
 *      不区分大小写、不区分前后空格的 includes 匹配
 *   4. 第一条命中的规则胜出，返回其 categoryId
 *
 * 该函数是 pure，不访问 Dexie；调用方负责从 db.rules 读取并传入。
 * 这样测试与复用更简单，且能在导入预览阶段对每行做 O(rules) 的同步应用。
 */

import type { TxRule, RuleMatchField } from '@/db';

/** 用于规则匹配的最小流水形状（兼容 ParsedTx 与 Transaction） */
export interface TxDraftLike {
  name?: string;
  merchant?: string;
  remark?: string;
}

/**
 * 取规则要匹配的字段值。若 matchField 对应字段为空，回退：
 *   name  →  merchant → remark（前置规则尽量多机会命中）
 *   merchant → name → remark
 *   remark → name → merchant
 */
function resolveFieldValue(
  draft: TxDraftLike,
  field: RuleMatchField,
): string {
  const candidates =
    field === 'name'
      ? [draft.name, draft.merchant, draft.remark]
      : field === 'merchant'
      ? [draft.merchant, draft.name, draft.remark]
      : [draft.remark, draft.name, draft.merchant];
  for (const v of candidates) {
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return '';
}

/** 单条规则是否匹配草稿 */
export function matchRule(rule: TxRule, draft: TxDraftLike): boolean {
  if (!rule.enabled) return false;
  const kw = rule.keyword.trim();
  if (!kw) return false;
  const target = resolveFieldValue(draft, rule.matchField);
  if (!target) return false;
  return target.toLowerCase().includes(kw.toLowerCase());
}

/**
 * 在草稿上应用规则，返回建议的 categoryId；无命中返回 null。
 * - 优先级 priority 降序
 * - 同优先级按 createdAt 升序（先创建先用）
 * - 第一条命中即返回
 */
export function applyRules(
  draft: TxDraftLike,
  rules: TxRule[],
): number | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  // 排序：不修改入参
  const sorted = [...rules].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return (a.createdAt ?? 0) - (b.createdAt ?? 0);
  });
  for (const r of sorted) {
    if (matchRule(r, draft)) return r.categoryId;
  }
  return null;
}

/**
 * 批量版本：对一组草稿并行计算建议分类 id。
 * 不会修改入参，返回与 input 等长的数组（未命中为 null）。
 */
export function applyRulesBatch<T extends TxDraftLike>(
  items: T[],
  rules: TxRule[],
): Array<number | null> {
  if (items.length === 0) return [];
  return items.map((it) => applyRules(it, rules));
}