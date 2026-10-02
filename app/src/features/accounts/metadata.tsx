/**
 * 账户类型元数据（仅供 accounts 模块内部使用）
 *
 * 集中管理类型名 / 描述 / 图标 / 分组（资产 vs 负债），UI 与提交逻辑都从这里取数。
 */
import type { ReactNode } from 'react';
import {
  IconWallet,
  IconBuildingBank,
  IconShield,
  IconChartLine,
  IconCategory,
  IconCreditCard,
  IconHomeMove,
  type Icon,
} from '@tabler/icons-react';
import type { AccountType } from '@/db';

export type AccountGroup = 'asset' | 'debt';

export interface AccountTypeMeta {
  type: AccountType;
  group: AccountGroup;
  /** 中文名称 */
  label: string;
  /** 详细描述 */
  description: string;
  /** 标签（icon component） */
  icon: Icon;
  /** Tabler 图标尺寸默认值 */
  size?: number;
}

export const ACCOUNT_TYPE_META: Record<AccountType, AccountTypeMeta> = {
  fund: {
    type: 'fund',
    group: 'asset',
    label: '资金',
    description: '日常收入和支出账户，例如银行储蓄卡、微信、支付宝、现金等',
    icon: IconWallet,
  },
  asset: {
    type: 'asset',
    group: 'asset',
    label: '资产',
    description: '保值或增值账户，如定期存款或为特定目标（如购房）准备的储蓄账户',
    icon: IconBuildingBank,
  },
  social: {
    type: 'social',
    group: 'asset',
    label: '社保',
    description: '社会保障相关的账户，包括社保、公积金和医疗保险等',
    icon: IconShield,
  },
  invest: {
    type: 'invest',
    group: 'asset',
    label: '投资',
    description: '投资活动的账户，如股票、基金、数字货币等投资工具',
    icon: IconChartLine,
  },
  other: {
    type: 'other',
    group: 'asset',
    label: '其他',
    description: '不属于以上类别的其他资产账户，如收藏品、艺术品或其他非常规资产',
    icon: IconCategory,
  },
  credit: {
    type: 'credit',
    group: 'debt',
    label: '信用',
    description: '提供信用额度的账户，如信用卡、花呗、京东白条等',
    icon: IconCreditCard,
  },
  debt: {
    type: 'debt',
    group: 'debt',
    label: '债务',
    description: '用于偿还债务的账户，如车贷、房贷或信用消费贷款等',
    icon: IconHomeMove,
  },
};

export const ASSET_TYPES: AccountType[] = ['fund', 'asset', 'social', 'invest', 'other'];
export const DEBT_TYPES: AccountType[] = ['credit', 'debt'];

/** 渲染类型图标的小工具（默认继承父级颜色，也可显式指定） */
export function renderTypeIcon(type: AccountType, size = 18, className?: string): ReactNode {
  const meta = ACCOUNT_TYPE_META[type];
  const Cmp = meta.icon;
  return <Cmp size={size} className={className} />;
}

/** 类型对应卡片底色（浅色文本色） */
export const ACCOUNT_TONE: Record<AccountType, string> = {
  fund: 'text-emerald-600 dark:text-emerald-400',
  asset: 'text-sky-600 dark:text-sky-400',
  social: 'text-violet-600 dark:text-violet-400',
  invest: 'text-indigo-600 dark:text-indigo-400',
  other: 'text-slate-600 dark:text-slate-400',
  credit: 'text-rose-600 dark:text-rose-400',
  debt: 'text-amber-600 dark:text-amber-400',
};

export const ACCOUNT_TONE_BG: Record<AccountType, string> = {
  fund: 'bg-emerald-100 dark:bg-emerald-900/30',
  asset: 'bg-sky-100 dark:bg-sky-900/30',
  social: 'bg-violet-100 dark:bg-violet-900/30',
  invest: 'bg-indigo-100 dark:bg-indigo-900/30',
  other: 'bg-slate-100 dark:bg-slate-800/50',
  credit: 'bg-rose-100 dark:bg-rose-900/30',
  debt: 'bg-amber-100 dark:bg-amber-900/30',
};
