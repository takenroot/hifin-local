import { useEffect, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { accentAtom, themeAtom } from './atoms';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * ThemeProvider：在 documentElement 上同步 dark class 与 data-accent。
 *
 * - theme === 'light'：始终浅色
 * - theme === 'dark'：始终暗黑
 * - theme === 'system'：跟随操作系统 prefers-color-scheme，实时响应系统切换
 *
 * data-accent：CSS 变量驱动的调色盘档位（charcoal/indigo/ocean/violet/rose），
 * 用 dataset 而不是 class——选择器 [data-accent='xxx'] 不进 Tailwind JIT 扫到的
 * class 名集合，避开了 Tailwind 把 'indigo' 'ocean' 当颜色 token 解析。
 * 写入走 effect 而非 DOM 属性直写：jotai 持久化状态改变时会自动同步过来。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme] = useAtom(themeAtom);
  const [accent] = useAtom(accentAtom);

  // 主题（dark class）
  useEffect(() => {
    const root = document.documentElement;

    const apply = (isDark: boolean) => {
      if (isDark) {
        root.classList.add('dark');
      } else {
        root.classList.remove('dark');
      }
    };

    if (theme === 'system') {
      const mql = window.matchMedia(SYSTEM_DARK_QUERY);
      apply(mql.matches);
      const handler = (e: MediaQueryListEvent) => apply(e.matches);
      mql.addEventListener('change', handler);
      return () => {
        mql.removeEventListener('change', handler);
      };
    }

    apply(theme === 'dark');
    return undefined;
  }, [theme]);

  // 调色盘（data-accent）——独立 effect，与 theme 解耦，
  // 切换 dark/light 不影响调色盘档（用户偏好独立保留）。
  useEffect(() => {
    document.documentElement.dataset.accent = accent;
  }, [accent]);

  return <>{children}</>;
}