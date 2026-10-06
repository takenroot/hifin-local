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
import dayjs from 'dayjs';

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

/**
 * 桌面侧边栏折叠态（false=展开 200px，true=收起 56px icon rail）。
 * 仅 lg 及以上生效；移动端抽屉不读此值。持久化，刷新保持。
 * 2026-10-06：收起态各段形态见 AppLayout SidebarBody 的 collapsed 分支。
 */
export const sidebarCollapsedAtom = atomWithStorage<boolean>('hifin:sidebarCollapsed', false);

/**
 * 主题色调色盘（2026-10 Wave 3）：5 档可切换。
 * - 'charcoal'：默认炭黑，复刻源 §11.2 极简语言
 * - 'indigo' / 'ocean' / 'violet' / 'rose'：彩色档，色值见 index.css
 * 语义色（income/expense/danger/success）不受此档影响——收入/支出/错误/成功
 * 是钱和操作语义的轴，不该被"我喜欢紫"覆盖。
 * ponytail: 默认 'charcoal' 与现有按钮/图表视觉一致——已是默认态，
 * 不需要额外的兼容期（见 themeAtom 注释里的 system 反选写法）。
 *
 * getOnInit: true —— jotai 2.x 的 atomWithStorage 默认在 init 时不同步
 * 读取 localStorage（先返回 initialValue，再下一帧更新）。ThemeProvider 的
 * useEffect 会先写错默认值 dataset.accent='charcoal'，再下次同步被
 * 'violet' 覆盖——视觉上是一次闪烁。getOnInit 让初始读就拿到真值。
 * 用 Option 显式声明，避免 jotai 升级后默认行为变化再次踩坑。
 */
export type AccentKey = 'charcoal' | 'indigo' | 'ocean' | 'violet' | 'rose';

export const accentAtom = atomWithStorage<AccentKey>('hifin:accent', 'charcoal', undefined, { getOnInit: true });

/* ───────────────── 交易流水：分组维度 / 统计月份 ───────────────── */

/**
 * 流水列表的分组维度（日 / 周 / 月 / 年），持久化。
 * 刷新后保持用户上次的分组档位，与主题 / 空间等偏好同级。
 */
export const txGroupDimAtom = atomWithStorage<'day' | 'week' | 'month' | 'year'>(
  'hifin:txGroupDim',
  'day',
);

/**
 * 统计 Tab 当前查看的月份，格式固定为 'YYYY-MM'，持久化。
 * 默认取模块加载时的当前月；渲染层会对未来月做钳制（翻页器同样禁用未来月），
 * 因此即使 localStorage 残留了远期月份也不会越界。
 */
export const txStatsMonthAtom = atomWithStorage<string>(
  'hifin:txStatsMonth',
  dayjs().format('YYYY-MM'),
);
