/**
 * 目标模块内部元数据：
 *   - 存款 / 还款 两个 kind 下的 subtype 选项
 *   - 图标 / 颜色 候选
 *
 * 仅供 goals 模块内部使用。
 */
import type { GoalKind } from '@/db';

export interface GoalSubtypeOption {
  /** 内部 subtype 名称（同时用作默认 name） */
  value: string;
  /** 中文标签 */
  label: string;
  /** Emoji 图标 */
  icon: string;
  /** 默认颜色 */
  color: string;
}

export const SAVING_SUBTYPES: GoalSubtypeOption[] = [
  { value: '买房', label: '买房', icon: '🏠', color: '#ef4444' },
  { value: '买车', label: '买车', icon: '🚗', color: '#f97316' },
  { value: '应急基金', label: '应急基金', icon: '🆘', color: '#0ea5e9' },
  { value: '教育', label: '教育', icon: '🎓', color: '#6366f1' },
  { value: '旅游', label: '旅游', icon: '✈️', color: '#ec4899' },
  { value: '存钱', label: '存钱', icon: '💰', color: '#f59e0b' },
  { value: '养老金', label: '养老金', icon: '👵', color: '#a855f7' },
  { value: '其他', label: '其他', icon: '🔖', color: '#6b7280' },
];

export const REPAYMENT_SUBTYPES: GoalSubtypeOption[] = [
  { value: '信用卡', label: '信用卡', icon: '💳', color: '#f43f5e' },
  { value: '助学贷款', label: '助学贷款', icon: '🎓', color: '#6366f1' },
  { value: '汽车贷款', label: '汽车贷款', icon: '🚗', color: '#f97316' },
  { value: '房贷', label: '房贷', icon: '🏠', color: '#ef4444' },
  { value: '其他', label: '其他', icon: '📌', color: '#6b7280' },
];

/** 给定 kind 返回对应的 subtype 列表 */
export function subtypesOf(kind: GoalKind): GoalSubtypeOption[] {
  return kind === 'saving' ? SAVING_SUBTYPES : REPAYMENT_SUBTYPES;
}

/** 根据 subtype 名称查找预定义的图标 / 颜色；若找不到则回落默认值 */
export function lookupMeta(kind: GoalKind, subtype: string | undefined): GoalSubtypeOption {
  const list = subtypesOf(kind);
  return (
    list.find((x) => x.value === subtype) ?? {
      value: subtype ?? '其他',
      label: subtype ?? '其他',
      icon: kind === 'saving' ? '💰' : '💳',
      color: kind === 'saving' ? '#10b981' : '#ef4444',
    }
  );
}

/** 候选颜色（用于第二步选择器） */
export const COLOR_CHOICES: string[] = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#0ea5e9',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#6b7280',
];

/** kind 的中文标签 */
export function kindLabel(kind: GoalKind): string {
  return kind === 'saving' ? '存款目标' : '还款目标';
}
