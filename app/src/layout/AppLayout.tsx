import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAtom, useAtomValue } from 'jotai';
import { useLiveQuery } from 'dexie-react-hooks';
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
  IconCheck,
  IconMenu2,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  menuVisibilityAtom,
  spaceIdAtom,
  commandPaletteOpenAtom,
} from '@/store/atoms';
import { db, type Space } from '@/db';
import { ALL_SPACES_ID, belongsToSpace } from '@/space';
import { CommandPaletteView as CommandPalette } from '@/features/command-palette/CommandPaletteView';
import { NotificationCenter } from '@/features/notifications/NotificationCenter';

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

/** UI 上的"全部空间"展示标签 */
const ALL_SPACES_LABEL = '全部空间';
const ALL_SPACES_DESC = '不过滤，显示所有空间的数据';

/**
 * 应用主布局：200px 固定侧边栏 + 右侧内容。
 *
 * 菜单显隐由 menuVisibilityAtom 控制；预算 / 发现当前跳回 /home。
 *
 * 多空间：侧边栏顶部从 db.spaces 实时拉取，"全部空间"以 sid=0 表示；
 * 切换空间直接写 spaceIdAtom。
 */
export default function AppLayout() {
  const mv = useMenuVisibility();
  const navigate = useNavigate();
  const location = useLocation();
  const [spaceId, setSpaceId] = useAtom(spaceIdAtom);
  const paletteOpen = useAtomValue(commandPaletteOpenAtom);
  const setPaletteOpen = useAtom(commandPaletteOpenAtom)[1];
  // 移动端侧栏抽屉
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

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

  // 路由切换后自动收起移动端侧栏
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // Esc 关闭移动端抽屉
  useEffect(() => {
    if (!mobileNavOpen) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMobileNavOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mobileNavOpen]);

  const items: NavItem[] = [
    { key: 'home', label: '看板', icon: <IconLayoutDashboard size={18} />, to: '/home' },
    { key: 'home', label: '账户', icon: <IconWallet size={18} />, to: '/account/list' },
    { key: 'home', label: '交易', icon: <IconArrowsLeftRight size={18} />, to: '/transaction' },
    { key: 'budget', label: '预算', icon: <IconCirclePlus size={18} />, to: '/budget' },
    { key: 'goal', label: '目标', icon: <IconTarget size={18} />, to: '/goal/list' },
    { key: 'report', label: '报表', icon: <IconChartBar size={18} />, to: '/report/list' },
    { key: 'discover', label: '发现', icon: <IconSparkles size={18} />, to: '/discover' },
  ];

  const visibleItems = items.filter((it) => {
    if (it.label === '预算') return mv.budget;
    if (it.label === '目标') return mv.goal;
    if (it.label === '报表') return mv.report;
    if (it.label === '发现') return mv.discover;
    return true;
  });

  // ─── 多空间：实时拉取 db.spaces，按 createdAt 排序 ───
  const spaces: Space[] =
    useLiveQuery(() => db.spaces.orderBy('name').toArray(), []) ?? [];

  // 计算底部展示名
  const currentSpaceName = (() => {
    if (spaceId === ALL_SPACES_ID) return ALL_SPACES_LABEL;
    const found = spaces.find((s) => s.id === spaceId);
    if (found) return found.name;
    // 当前 id 已无效（被删除或从未存在）⇒ 回退默认空间
    const fallback = spaces.find((s) => s.id === 1);
    return fallback?.name ?? ALL_SPACES_LABEL;
  })();

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg dark:bg-bg-dark text-text dark:text-text-dark">
      {/* 桌面侧边栏（lg 及以上常驻） */}
      <aside className="hidden lg:flex w-[200px] flex-none border-r border-border dark:border-border-dark flex-col bg-bg-card dark:bg-bg-card-dark">
        <SidebarBody
          spaces={spaces}
          spaceId={spaceId}
          onPick={(id) => setSpaceId(id)}
          onOpenPalette={() => setPaletteOpen(true)}
          onNavigateSettings={() => navigate('/settings')}
          currentSpaceName={currentSpaceName}
          visibleItems={visibleItems}
          pathname={location.pathname}
        />
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* 移动端顶栏（汉堡 + 当前页标题） */}
        <div className="lg:hidden flex items-center gap-2 h-12 px-4 border-b border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark flex-none">
          <button
            type="button"
            aria-label="打开菜单"
            onClick={() => setMobileNavOpen(true)}
            className="w-9 h-9 -ml-1 rounded-lg flex items-center justify-center text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
          >
            <IconMenu2 size={20} />
          </button>
          <span className="text-sm font-medium truncate">
            {visibleItems.find((it) => location.pathname.startsWith(it.to))?.label ?? 'HiFin'}
          </span>
        </div>

        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>

      {/* 移动端抽屉（遮罩 + 滑入侧栏） */}
      <div
        className={clsx(
          'lg:hidden fixed inset-0 z-40 transition-opacity duration-200',
          mobileNavOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        aria-hidden={!mobileNavOpen}
      >
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={() => setMobileNavOpen(false)}
        />
        <aside
          className={clsx(
            'absolute left-0 top-0 bottom-0 w-[260px] max-w-[80vw] flex flex-col bg-bg-card dark:bg-bg-card-dark border-r border-border dark:border-border-dark transition-transform duration-200',
            mobileNavOpen ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <div className="flex items-center justify-between px-3 pt-4 pb-1">
            <span className="text-sm font-medium">导航</span>
            <button
              type="button"
              aria-label="关闭菜单"
              onClick={() => setMobileNavOpen(false)}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
            >
              <IconX size={18} />
            </button>
          </div>
          <SidebarBody
            spaces={spaces}
            spaceId={spaceId}
            onPick={(id) => setSpaceId(id)}
            onOpenPalette={() => {
              setMobileNavOpen(false);
              setPaletteOpen(true);
            }}
            onNavigateSettings={() => {
              setMobileNavOpen(false);
              navigate('/settings');
            }}
            currentSpaceName={currentSpaceName}
            visibleItems={visibleItems}
            pathname={location.pathname}
          />
        </aside>
      </div>

      {/* Command palette */}
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} navigate={navigate} />

      {/* 全局通知中心：轮询待处理通知，需要密码时弹窗、导入结果走 toast */}
      <NotificationCenter />
    </div>
  );
}

/* ─────────────────── SidebarBody 共享子组件 ─────────────────── */

interface SidebarBodyProps {
  spaces: Space[];
  spaceId: number;
  onPick: (id: number) => void;
  onOpenPalette: () => void;
  onNavigateSettings: () => void;
  currentSpaceName: string;
  visibleItems: NavItem[];
  pathname: string;
}

function SidebarBody({
  spaces,
  spaceId,
  onPick,
  onOpenPalette,
  onNavigateSettings,
  currentSpaceName,
  visibleItems,
  pathname,
}: SidebarBodyProps) {
  return (
    <>
      {/* Space switcher */}
      <SpaceSwitcher
        spaces={spaces}
        spaceId={spaceId}
        onPick={onPick}
      />

      {/* Search */}
      <div className="px-3 pt-1 pb-3">
        <button
          type="button"
          onClick={onOpenPalette}
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
          const active = pathname.startsWith(it.to);
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
          onClick={onNavigateSettings}
          className="w-full flex items-center gap-2.5 h-9 px-3 rounded-xl text-sm text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark transition"
        >
          <IconSettings size={18} />
          <span>设置</span>
        </button>
        <div className="flex items-center gap-2 px-2 pt-1">
          <div className="w-7 h-7 rounded-full bg-gradient-to-br from-pink-300 to-violet-400 flex-none" />
          <div className="text-xs text-text-muted truncate">{currentSpaceName}</div>
        </div>
      </div>
    </>
  );
}

/* ─────────────────── SpaceSwitcher 子组件 ─────────────────── */

interface SpaceSwitcherProps {
  spaces: Space[];
  spaceId: number;
  onPick: (id: number) => void;
}

function SpaceSwitcher({ spaces, spaceId, onPick }: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');

  // 头部按钮的展示名
  const headerLabel = (() => {
    if (spaceId === ALL_SPACES_ID) return ALL_SPACES_LABEL;
    return spaces.find((s) => s.id === spaceId)?.name ?? ALL_SPACES_LABEL;
  })();

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    // 重名检查：避免在空间中建两条同名
    const dup = spaces.find((s) => s.name === name);
    if (dup) {
      // 直接切换到同名空间
      if (dup.id != null) onPick(dup.id);
      setNewName('');
      setAdding(false);
      setOpen(false);
      return;
    }
    const id = await db.spaces.add({
      name,
      createdAt: Date.now(),
    });
    if (typeof id === 'number') onPick(id);
    setNewName('');
    setAdding(false);
    setOpen(false);
  }

  return (
    <div className="relative px-3 pt-4 pb-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between gap-2 h-10 px-3 rounded-xl hover:bg-bg dark:hover:bg-bg-dark transition"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark flex items-center justify-center flex-none">
            <IconLayersIntersect size={14} />
          </div>
          <span className="text-sm font-medium truncate">{headerLabel}</span>
        </div>
        <IconChevronDown size={14} className="text-text-muted" />
      </button>

      {open && (
        <div
          className="absolute left-3 right-3 mt-1 z-30 card !p-1 !rounded-xl"
          onMouseLeave={() => {
            if (!adding) setOpen(false);
          }}
        >
          {/* 全部空间 */}
          <button
            type="button"
            onClick={() => {
              onPick(ALL_SPACES_ID);
              setOpen(false);
              setAdding(false);
            }}
            className={clsx(
              'w-full text-left px-3 h-8 text-sm rounded-lg hover:bg-bg dark:hover:bg-bg-dark flex items-center justify-between gap-2',
              spaceId === ALL_SPACES_ID && 'font-medium',
            )}
          >
            <span className="truncate">{ALL_SPACES_LABEL}</span>
            {spaceId === ALL_SPACES_ID && (
              <IconCheck size={12} className="text-income flex-none" />
            )}
          </button>

          {/* 已有空间列表 */}
          {spaces.map((s) => {
            if (s.id == null) return null;
            const active = belongsToSpace({ spaceId: s.id }, spaceId) && spaceId !== ALL_SPACES_ID;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onPick(s.id as number);
                  setOpen(false);
                  setAdding(false);
                }}
                className={clsx(
                  'w-full text-left px-3 h-8 text-sm rounded-lg hover:bg-bg dark:hover:bg-bg-dark flex items-center justify-between gap-2',
                  active && 'font-medium',
                )}
              >
                <span className="truncate">{s.name}</span>
                {active && (
                  <IconCheck size={12} className="text-income flex-none" />
                )}
              </button>
            );
          })}

          {/* 新建空间入口 */}
          {!adding ? (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="w-full text-left px-3 h-8 text-sm rounded-lg text-text-muted hover:bg-bg dark:hover:bg-bg-dark flex items-center gap-1"
            >
              <IconCirclePlus size={12} />
              <span>添加空间</span>
            </button>
          ) : (
            <div className="px-2 py-2 space-y-2 border-t border-border dark:border-border-dark mt-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreate();
                  } else if (e.key === 'Escape') {
                    setAdding(false);
                    setNewName('');
                  }
                }}
                placeholder="空间名称"
                maxLength={20}
                className="w-full h-8 px-2 rounded-lg bg-bg dark:bg-bg-dark border border-border dark:border-border-dark text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewName('');
                  }}
                  className="flex-1 h-7 rounded-lg text-xs text-text-muted hover:bg-bg dark:hover:bg-bg-dark"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={!newName.trim()}
                  className={clsx(
                    'flex-1 h-7 rounded-lg text-xs font-medium transition',
                    newName.trim()
                      ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                      : 'bg-bg dark:bg-bg-dark text-text-muted cursor-not-allowed',
                  )}
                >
                  创建
                </button>
              </div>
            </div>
          )}

          {/* 描述 / 统计 */}
          <div className="px-3 pt-2 pb-1 text-[10px] text-text-muted leading-relaxed">
            {spaceId === ALL_SPACES_ID
              ? ALL_SPACES_DESC
              : `当前仅展示「${headerLabel}」中的数据`}
          </div>
        </div>
      )}
    </div>
  );
}