/**
 * Jotai 原子（持久化到 localStorage）
 *
 * 约定：
 *  - 所有 atom 必须在文件内 export，供全应用共享。
 *  - 主题 / 语言 / 菜单 / 默认页等 UI 偏好通过 atomWithStorage 持久化。
 *  - commandPaletteOpenAtom 是运行时状态。
 *
 * 多空间：
 *  - spaceIdAtom 是当前激活的空间 id（持久化），0 表示"全部空间"。
 *  - 默认 1（默认空间）。
 *  - 历史兼容：老 spaceAtom（仅持久化空间名）保留以免大面积破坏 UI 文案，
 *    新增 / 删除空间、切换空间请通过 spaceIdAtom + db.spaces。
 */

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export type Theme = 'light' | 'dark' | 'system';

/** 主题模式。document.documentElement.classList 通过 ThemeProvider 同步 */
export const themeAtom = atomWithStorage<Theme>('hifin:theme', 'system');

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
    discover: true, // 发现页已实装
  },
);

/** 命令面板（⌘K）开关 */
export const commandPaletteOpenAtom = atom<boolean>(false);

/**
 * 当前激活空间 id（持久化到 localStorage）。
 *  - 0  ：全部空间（不过滤）
 *  - 1+ ：具体空间 id（来自 db.spaces 表）
 */
export const spaceIdAtom = atomWithStorage<number>('hifin:spaceId', 1);

/**
 * 历史遗留：仅持久化空间名称。新 UI 已切到 spaceIdAtom + db.spaces，
 * 此处保留旧 atom 以避免其它模块大面积报错；不再用于业务逻辑。
 */
export const spaceAtom = atomWithStorage<string>('hifin:space', '默认空间');