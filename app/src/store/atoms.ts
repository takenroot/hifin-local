/**
 * Jotai 原子（持久化到 localStorage）
 *
 * 约定：
 *  - 所有 atom 必须在文件内 export，供全应用共享。
 *  - 主题 / 语言 / 菜单 / 默认页等 UI 偏好通过 atomWithStorage 持久化。
 *  - commandPaletteOpenAtom / spaceAtom 是运行时状态，spaceAtom 仅持久化所选名称。
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export type Theme = 'light' | 'dark';

/** 主题模式。document.documentElement.classList 通过 ThemeProvider 同步 */
export const themeAtom = atomWithStorage<Theme>('hifin:theme', 'light');

/** 语言。预留 i18n 接口，目前固定 zh-CN */
export const languageAtom = atomWithStorage<string>('hifin:language', 'zh-CN');

/** 默认登录页：home | account | transaction | goal | report */
export const defaultPageAtom = atomWithStorage<string>(
  'hifin:defaultPage',
  'home',
);

/** 侧边栏菜单显隐 */
export interface MenuVisibility {
  home: boolean;
  budget: boolean;
  goal: boolean;
  report: boolean;
  discover: boolean;
}

export const menuVisibilityAtom = atomWithStorage<MenuVisibility>(
  'hifin:menuVisibility',
  {
    home: true,
    budget: true, // 预算模块已实装
    goal: true,
    report: true,
    discover: false,
  },
);

/** 命令面板（⌘K）开关 */
export const commandPaletteOpenAtom = atom<boolean>(false);

/** 当前空间：仅持久化名称 */
export const spaceAtom = atomWithStorage<string>('hifin:space', '默认空间');
