import { useEffect, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { themeAtom } from './atoms';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * ThemeProvider：在 documentElement 上同步 dark class，并订阅 jotai 主题。
 *
 * - theme === 'light'：始终浅色
 * - theme === 'dark'：始终暗黑
 * - theme === 'system'：跟随操作系统 prefers-color-scheme，实时响应系统切换
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme] = useAtom(themeAtom);

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

  return <>{children}</>;
}