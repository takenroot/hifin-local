/**
 * 设置页左侧菜单元数据（分组 + 子项）。
 *
 * 单一来源：路由 section key、菜单 label、图标、可用性都在这里声明。
 * SettingsLayout 与 SettingsPage 都从这里消费。
 */
import type { ReactNode } from 'react';
import {
  IconUser,
  IconPalette,
  IconShieldLock,
  IconRobot,
  IconLayersIntersect,
  IconUpload,
  IconCategory,
  IconTag,
  IconBuildingStore,
  IconFileText,
  IconInfoCircle,
} from '@tabler/icons-react';

export type SettingsSectionKey =
  | 'profile'
  | 'preferences'
  | 'security'
  | 'ai'
  | 'space'
  | 'import'
  | 'categories'
  | 'rules'
  | 'tags'
  | 'merchants'
  | 'about';

export interface SettingsSectionMeta {
  key: SettingsSectionKey;
  label: string;
  icon: ReactNode;
  /** description for ?section deep link */
  description?: string;
}

export interface SettingsGroup {
  /** 分组标题 */
  label: string;
  /** 分组副标题 */
  description?: string;
  items: SettingsSectionMeta[];
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  {
    label: '通用配置',
    items: [
      { key: 'profile', label: '用户信息', icon: <IconUser size={16} /> },
      { key: 'preferences', label: '个性偏好', icon: <IconPalette size={16} /> },
      { key: 'security', label: '数据安全', icon: <IconShieldLock size={16} /> },
      { key: 'ai', label: 'AI 配置', icon: <IconRobot size={16} /> },
    ],
  },
  {
    label: '当前空间',
    items: [
      { key: 'space', label: '空间配置', icon: <IconLayersIntersect size={16} /> },
      { key: 'import', label: '账单导入', icon: <IconUpload size={16} /> },
      { key: 'categories', label: '分组分类', icon: <IconCategory size={16} /> },
      { key: 'rules', label: '交易规则', icon: <IconFileText size={16} /> },
      { key: 'tags', label: '标签', icon: <IconTag size={16} /> },
      { key: 'merchants', label: '商户', icon: <IconBuildingStore size={16} /> },
    ],
  },
  {
    label: '产品信息',
    items: [
      { key: 'about', label: '关于', icon: <IconInfoCircle size={16} /> },
    ],
  },
];

/** 全部 sections 列表（用于校验 section key） */
export const ALL_SECTIONS: SettingsSectionMeta[] = SETTINGS_GROUPS.flatMap((g) => g.items);

export const DEFAULT_SECTION: SettingsSectionKey = 'profile';

/** 把 section key 解析为合法值（不合法则回退默认） */
export function resolveSection(raw: string | null): SettingsSectionKey {
  if (!raw) return DEFAULT_SECTION;
  if (ALL_SECTIONS.some((s) => s.key === raw)) return raw as SettingsSectionKey;
  return DEFAULT_SECTION;
}

/** 默认页选项（用于「设置 → 个性偏好 → 默认登录页」） */
export const DEFAULT_PAGE_OPTIONS: { label: string; value: string }[] = [
  { label: '看板', value: 'home' },
  { label: '账户', value: 'account' },
  { label: '交易', value: 'transaction' },
  { label: '目标', value: 'goal' },
  { label: '报表', value: 'report' },
  { label: '设置', value: 'settings' },
];

/** 语言占位选项（当前仅简体中文，但仍提供切换 UI） */
export const LANGUAGE_OPTIONS: { label: string; value: string }[] = [
  { label: '简体中文', value: 'zh-CN' },
  { label: 'English（占位）', value: 'en' },
  { label: '日本語（占位）', value: 'ja' },
];