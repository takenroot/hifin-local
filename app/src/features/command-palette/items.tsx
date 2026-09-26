/**
 * 命令面板内置指令项（菜单 / 快捷动作 / 操作）。
 *
 * 这里仅声明静态数据；运行时过滤 + 渲染由 CommandPalette.tsx 完成。
 */
import type { ReactNode } from 'react';
import {
  IconPlus,
  IconArrowsLeftRight,
  IconLayoutDashboard,
  IconWallet,
  IconTarget,
  IconChartBar,
  IconSettings,
  IconLifebuoy,
  IconCategory,
  IconCirclePlus,
  IconSparkles,
} from '@tabler/icons-react';

export interface CmdItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  to: string;
  icon?: ReactNode;
  /** 快捷键字符（仅展示，⌘K 由 AppLayout 控制） */
  shortcut?: string;
  /** 是否在底部带 secondary 文本（弹层用） */
  description?: string;
}

export const CMD_ITEMS: CmdItem[] = [
  // ── 快捷操作 ──
  {
    id: 'new-tx',
    label: '新建流水',
    group: '快捷操作',
    to: '/transaction?create=1',
    icon: <IconPlus size={14} />,
    shortcut: 't',
  },
  {
    id: 'new-acc',
    label: '新建账户',
    group: '快捷操作',
    to: '/account/list?create=1',
    icon: <IconPlus size={14} />,
    shortcut: 'n',
  },
  {
    id: 'new-cat',
    label: '新建分类',
    group: '快捷操作',
    to: '/settings?section=categories',
    icon: <IconCategory size={14} />,
    shortcut: 'c',
  },
  {
    id: 'open-ai',
    label: 'AI 助手',
    group: '快捷操作',
    to: '/ai',
    icon: <IconSparkles size={14} />,
    shortcut: 'a',
    description: '打开 AI 助手（需先在设置中配置模型）',
  },
  // ── 打开目录 ──
  {
    id: 'go-home',
    label: '看板',
    group: '打开目录',
    to: '/home',
    icon: <IconLayoutDashboard size={14} />,
  },
  {
    id: 'go-account',
    label: '账户',
    group: '打开目录',
    to: '/account/list',
    icon: <IconWallet size={14} />,
  },
  {
    id: 'go-transaction',
    label: '交易',
    group: '打开目录',
    to: '/transaction',
    icon: <IconArrowsLeftRight size={14} />,
  },
  {
    id: 'go-goal',
    label: '目标',
    group: '打开目录',
    to: '/goal/list',
    icon: <IconTarget size={14} />,
  },
  {
    id: 'go-report',
    label: '报表',
    group: '打开目录',
    to: '/report/list',
    icon: <IconChartBar size={14} />,
  },
  {
    id: 'go-budget',
    label: '预算',
    group: '打开目录',
    to: '/home',
    icon: <IconCirclePlus size={14} />,
  },
  {
    id: 'go-discover',
    label: '发现',
    group: '打开目录',
    to: '/home',
    icon: <IconSparkles size={14} />,
  },
  // ── 操作 ──
  {
    id: 'op-settings',
    label: '设置',
    group: '操作',
    to: '/settings',
    icon: <IconSettings size={14} />,
    shortcut: 's',
  },
  {
    id: 'op-help',
    label: '帮助说明',
    group: '操作',
    to: '__help__',
    icon: <IconLifebuoy size={14} />,
    description: '查看快捷键与本地版本说明',
  },
];