import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import {
  IconLayoutDashboard,
  IconWallet,
  IconArrowsLeftRight,
  IconTarget,
  IconChartBar,
  IconSearch,
  IconSettings,
  IconChevronDown,
  IconCirclePlus,
  IconLayersIntersect,
  IconSparkles,
  IconCommand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { menuVisibilityAtom, spaceAtom, commandPaletteOpenAtom } from '@/store/atoms';
import { CommandPaletteView as CommandPalette } from '@/features/command-palette/CommandPaletteView';

interface NavItem {
  key: keyof ReturnType<typeof useMenuVisibility>;
  label: string;
  icon: ReactNode;
  to: string;
}

function useMenuVisibility() {
  const [mv] = useAtom(menuVisibilityAtom);
  return mv;
}

/**
 * 应用主布局：200px 固定侧边栏 + 右侧内容。
 *
 * 菜单显隐由 menuVisibilityAtom 控制；预算 / 发现当前跳回 /home。
 */
export default function AppLayout() {
  const mv = useMenuVisibility();
  const navigate = useNavigate();
  const location = useLocation();
  const [space, setSpace] = useAtom(spaceAtom);
  const paletteOpen = useAtomValue(commandPaletteOpenAtom);
  const setPaletteOpen = useAtom(commandPaletteOpenAtom)[1];

  // 全局 ⌘K / Ctrl+K 切换命令面板
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setPaletteOpen]);

  const items: NavItem[] = [
    { key: 'home', label: '看板', icon: <IconLayoutDashboard size={18} />, to: '/home' },
    { key: 'home', label: '账户', icon: <IconWallet size={18} />, to: '/account/list' },
    { key: 'home', label: '交易', icon: <IconArrowsLeftRight size={18} />, to: '/transaction' },
    { key: 'budget', label: '预算', icon: <IconCirclePlus size={18} />, to: '/home' },
    { key: 'goal', label: '目标', icon: <IconTarget size={18} />, to: '/goal/list' },
    { key: 'report', label: '报表', icon: <IconChartBar size={18} />, to: '/report/list' },
    { key: 'discover', label: '发现', icon: <IconSparkles size={18} />, to: '/home' },
  ];

  const visibleItems = items.filter((it) => {
    if (it.label === '预算') return mv.budget;
    if (it.label === '目标') return mv.goal;
    if (it.label === '报表') return mv.report;
    if (it.label === '发现') return mv.discover;
    return true;
  });

  const [spaceMenuOpen, setSpaceMenuOpen] = useState(false);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg dark:bg-bg-dark text-text dark:text-text-dark">
      {/* Sidebar */}
      <aside className="w-[200px] flex-none border-r border-border dark:border-border-dark flex flex-col bg-bg-card dark:bg-bg-card-dark">
        {/* Space switcher */}
        <div className="relative px-3 pt-4 pb-2">
          <button
            type="button"
            onClick={() => setSpaceMenuOpen((v) => !v)}
            className="w-full flex items-center justify-between gap-2 h-10 px-3 rounded-xl hover:bg-bg dark:hover:bg-bg-dark transition"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark flex items-center justify-center flex-none">
                <IconLayersIntersect size={14} />
              </div>
              <span className="text-sm font-medium truncate">{space}</span>
            </div>
            <IconChevronDown size={14} className="text-text-muted" />
          </button>
          {spaceMenuOpen && (
            <div className="absolute left-3 right-3 mt-1 z-30 card !p-1 !rounded-xl">
              {['默认空间', '全部空间'].map((s) => (
                <button
                  key={s}
                  onClick={() => {
                    setSpace(s);
                    setSpaceMenuOpen(false);
                  }}
                  className={clsx(
                    'w-full text-left px-3 h-8 text-sm rounded-lg hover:bg-bg dark:hover:bg-bg-dark',
                    s === space && 'font-medium',
                  )}
                >
                  {s}
                </button>
              ))}
              <button
                onClick={() => setSpaceMenuOpen(false)}
                className="w-full text-left px-3 h-8 text-sm rounded-lg text-text-muted hover:bg-bg dark:hover:bg-bg-dark"
              >
                + 添加空间
              </button>
            </div>
          )}
        </div>

        {/* Search */}
        <div className="px-3 pt-1 pb-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="w-full flex items-center justify-between gap-2 h-9 px-3 rounded-xl bg-bg dark:bg-bg-dark text-text-muted hover:text-text dark:hover:text-text-dark transition"
          >
            <span className="flex items-center gap-2">
              <IconSearch size={14} />
              <span className="text-sm">搜索</span>
            </span>
            <span className="flex items-center gap-1 text-xs">
              <IconCommand size={12} />K
            </span>
          </button>
        </div>

        {/* Main nav */}
        <nav className="flex-1 px-2 space-y-0.5 overflow-auto">
          {visibleItems.map((it) => {
            const active = location.pathname.startsWith(it.to);
            return (
              <NavLink
                key={it.label}
                to={it.to}
                className={clsx(
                  'flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm transition',
                  active
                    ? 'bg-bg dark:bg-bg-dark font-medium text-text dark:text-text-dark'
                    : 'text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark',
                )}
              >
                <span className="flex-none text-text-muted">{it.icon}</span>
                <span className="truncate">{it.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Settings & profile */}
        <div className="px-3 pt-2 pb-3 border-t border-border dark:border-border-dark space-y-1">
          <button
            type="button"
            onClick={() => navigate('/settings')}
            className="w-full flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark transition"
          >
            <IconSettings size={18} />
            <span>设置</span>
          </button>
          <div className="flex items-center gap-2 px-2 pt-1">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-pink-300 to-violet-400 flex-none" />
            <div className="text-xs text-text-muted truncate">{space}</div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>

      {/* Command palette */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} navigate={navigate} />
    </div>
  );
}
