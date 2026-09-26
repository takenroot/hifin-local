import { useEffect, type ReactNode } from 'react';
import { useAtom } from 'jotai';
import { themeAtom } from './atoms';

/**
 * ThemeProvider：在 documentElement 上同步 dark class，并订阅 jotai 主题。
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme] = useAtom(themeAtom);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  return <>{children}</>;
}
