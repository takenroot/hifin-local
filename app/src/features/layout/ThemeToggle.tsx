/**
 * ThemeToggle — 日/月主题切换按钮（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 工具排里的日夜切换按钮。图标显示当前解析态：
 *   - 当前解析态 light → IconSun
 *   - 当前解析态 dark  → IconMoon
 * 点击切换：light→dark / dark→light / system→反选 matchMedia（设计要求）。
 *
 * ponytail: 解析态单独 useMemo 算，theme === 'system' 时实时订阅 mql——
 * 跟 ThemeProvider 的实现重复一份，但这是最小代价：ThemeProvider 把 class
 * 写到 documentElement，组件层只关心"现在看起来是哪个态"。把解析逻辑放进
 * ThemeProvider 反而把它变成"必须被组件 import 的依赖"，不值得。
 */
import { useEffect, useMemo, useState } from 'react';
import { IconMoon, IconSun } from '@tabler/icons-react';
import clsx from 'clsx';
import { useAtom } from 'jotai';
import { themeAtom, type Theme } from '@/store/atoms';

const SYSTEM_DARK_QUERY = '(prefers-color-scheme: dark)';

interface ThemeToggleProps {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed = false }: ThemeToggleProps) {
  const [theme, setTheme] = useAtom(themeAtom);
  // 当前解析态：system 跟随系统，否则与 theme 同值
  const [systemDark, setSystemDark] = useState(() =>
    typeof window === 'undefined' ? false : window.matchMedia(SYSTEM_DARK_QUERY).matches,
  );

  useEffect(() => {
    if (theme !== 'system') return;
    const mql = window.matchMedia(SYSTEM_DARK_QUERY);
    const handler = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [theme]);

  const resolved = useMemo<'light' | 'dark'>(
    () => (theme === 'system' ? (systemDark ? 'dark' : 'light') : (theme as 'light' | 'dark')),
    [theme, systemDark],
  );

  function toggle() {
    // 跟随系统：点一下切到反选（写死值，不再依赖系统）
    if (theme === 'system') {
      setTheme(resolved === 'dark' ? 'light' : 'dark');
      return;
    }
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  const title = collapsed
    ? `主题（当前：${resolved === 'dark' ? '深色' : '浅色'}，点击切换）`
    : undefined;

  return (
    <button
      type="button"
      onClick={toggle}
      title={title}
      aria-label={`切换主题（当前：${resolved === 'dark' ? '深色' : '浅色'}）`}
      className={clsx(
        'flex items-center justify-center w-9 h-9 rounded-xl text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-dark transition',
      )}
    >
      {resolved === 'dark' ? <IconMoon size={18} /> : <IconSun size={18} />}
    </button>
  );
}

/** 导出供测试断言 — 不暴露给业务侧 */
export const __RESOLVED_THEME_OF = (theme: Theme, systemDark: boolean): 'light' | 'dark' =>
  theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
