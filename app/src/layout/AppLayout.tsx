import { useEffect, useMemo, useState, type ReactNode } from 'react';
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
  IconCheck,
  IconMenu2,
  IconX,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  menuVisibilityAtom,
  spaceIdAtom,
  commandPaletteOpenAtom,
  sidebarCollapsedAtom,
} from '@/store/atoms';
import type { Space } from '@/db';
import { useApi, apiFetch } from '@/hooks/useApi';
import { ALL_SPACES_ID, belongsToSpace } from '@/space';
import { CommandPaletteView as CommandPalette } from '@/features/command-palette/CommandPaletteView';
import { NotificationCenter } from '@/features/notifications/NotificationCenter';
import { toNotificationList } from '@/features/notifications/types';
import { toSpaces, type RestSpaceRow } from '@/features/settings/restApi';

interface NavItem {
  key: keyof ReturnType<typeof useMenuVisibility>;
  label: string;
  icon: ReactNode;
  to: string;
  /** 激活态匹配前缀（段匹配）；缺省用 to */
  match?: string;
}

// 段前缀匹配：/account 命中 /account 与 /account/detail/1，但不命中 /accountant
function isNavActive(it: NavItem, pathname: string): boolean {
  const prefix = it.match ?? it.to;
  return pathname === prefix || pathname.startsWith(prefix + '/');
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
  // 桌面侧边栏折叠态（仅 lg+ 生效，持久化；收起形态约定见 atoms.ts 注释）
  const [sidebarCollapsed, setSidebarCollapsed] = useAtom(sidebarCollapsedAtom);

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
    { key: 'home', label: '账户', icon: <IconWallet size={18} />, to: '/account/list', match: '/account' },
    { key: 'home', label: '交易', icon: <IconArrowsLeftRight size={18} />, to: '/transaction' },
    { key: 'budget', label: '预算', icon: <IconCirclePlus size={18} />, to: '/budget' },
    { key: 'goal', label: '目标', icon: <IconTarget size={18} />, to: '/goal/list', match: '/goal' },
    { key: 'report', label: '报表', icon: <IconChartBar size={18} />, to: '/report/list', match: '/report' },
    { key: 'discover', label: '发现', icon: <IconSparkles size={18} />, to: '/discover' },
  ];
  const visibleItems = items.filter((it) => {
    if (it.label === '预算') return mv.budget;
    if (it.label === '目标') return mv.goal;
    if (it.label === '报表') return mv.report;
    if (it.label === '发现') return mv.discover;
    return true;
  });

  // ─── 多空间：从 REST 拉取（迁移前是 db.spaces），按 name 排序 ───
  const {
    data: restSpaces,
    refetch: refetchSpaces,
  } = useApi<RestSpaceRow[]>('/api/spaces');
  const spaces: Space[] = useMemo(
    () => toSpaces(restSpaces ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [restSpaces],
  );

  // ─── 看板角标：有未处理的 AI 洞察通知时挂一个小红点 ───
  // 复用现有轮询（NotificationCenter 已 30s 拉一次 pending），这里再拉一份避免与弹窗时序耦合；
  // 网络抖动静默失败，UI 退化到无角标，**不**显示骨架/Loading。
  const { data: insightRaw } = useApi<unknown>(
    '/api/notifications?status=pending&type=ai-insight',
  );
  const hasPendingAiInsight = useMemo(
    () => toNotificationList(insightRaw).length > 0,
    [insightRaw],
  );

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
    <div
      className="flex h-dvh w-screen overflow-hidden bg-bg dark:bg-bg-dark text-text dark:text-text-dark"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {/* 桌面侧边栏（lg 及以上常驻；可折叠为 icon rail，宽度 200ms 过渡） */}
      <aside
        className={clsx(
          'hidden lg:flex flex-none border-r border-border dark:border-border-dark flex-col bg-bg-card dark:bg-bg-card-dark transition-[width] duration-200 ease-out',
          sidebarCollapsed ? 'w-14' : 'w-[200px]',
        )}
      >
        <SidebarBody
          spaces={spaces}
          spaceId={spaceId}
          onPick={(id) => setSpaceId(id)}
          onRefreshSpaces={refetchSpaces}
          onOpenPalette={() => setPaletteOpen(true)}
          onNavigateSettings={() => navigate('/settings')}
          currentSpaceName={currentSpaceName}
          visibleItems={visibleItems}
          pathname={location.pathname}
          hasPendingAiInsight={hasPendingAiInsight}
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
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
            {visibleItems.find((it) => isNavActive(it, location.pathname))?.label ?? 'HiFin'}
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
            onRefreshSpaces={refetchSpaces}
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
            hasPendingAiInsight={hasPendingAiInsight}
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
  onRefreshSpaces: () => void;
  onOpenPalette: () => void;
  onNavigateSettings: () => void;
  currentSpaceName: string;
  visibleItems: NavItem[];
  pathname: string;
  /** 看板有未处理 AI 洞察通知时挂小红点 */
  hasPendingAiInsight?: boolean;
  /** 桌面折叠态：收起为 icon rail（仅桌面传，移动端抽屉恒为展开） */
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}

function SidebarBody({
  spaces,
  spaceId,
  onPick,
  onRefreshSpaces,
  onOpenPalette,
  onNavigateSettings,
  currentSpaceName,
  visibleItems,
  pathname,
  hasPendingAiInsight,
  collapsed = false,
  onToggleCollapse,
}: SidebarBodyProps) {
  return (
    <>
      {/* Space switcher */}
      <SpaceSwitcher
        spaces={spaces}
        spaceId={spaceId}
        onPick={onPick}
        onRefreshSpaces={onRefreshSpaces}
        collapsed={collapsed}
      />

      {/* Search：收起态退化为纯图标按钮，tooltip 用原生 title（Kowalski：低频操作不上悬浮层框架） */}
      <div className={clsx('pt-1 pb-3', collapsed ? 'px-2.5' : 'px-3')}>
        <button
          type="button"
          onClick={onOpenPalette}
          title="搜索（⌘K）"
          aria-label="搜索（⌘K）"
          className={clsx(
            'flex items-center rounded-xl bg-bg dark:bg-bg-dark text-text-muted hover:text-text dark:hover:text-text-dark transition',
            collapsed ? 'w-9 h-9 justify-center' : 'w-full justify-between gap-2 h-9 px-3',
          )}
        >
          <span className={clsx('flex items-center', !collapsed && 'gap-2')}>
            <IconSearch size={14} />
            {!collapsed && <span className="text-sm">搜索</span>}
          </span>
          {!collapsed && (
            <span className="flex items-center gap-1 text-xs">
              <IconCommand size={12} />K
            </span>
          )}
        </button>
      </div>

      {/* Main nav */}
      <nav className="flex-1 px-2 space-y-0.5 overflow-auto">
        {visibleItems.map((it) => {
          const active = isNavActive(it, pathname);
          // 看板：未处理 AI 洞察通知时挂一个小红点（视觉信号：点击进去即看到通知中心 Modal）
          const showBadge = it.label === '看板' && hasPendingAiInsight;
          return (
            <NavLink
              key={it.label}
              to={it.to}
              title={collapsed ? it.label : undefined}
              className={clsx(
                'flex items-center h-9 rounded-xl text-sm transition',
                collapsed ? 'justify-center px-0' : 'gap-2.5 px-3',
                active
                  ? 'bg-bg dark:bg-bg-dark font-medium text-text dark:text-text-dark'
                  : 'text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark',
              )}
            >
              <span className={clsx('flex-none text-text-muted', collapsed && 'relative')}>
                {it.icon}
                {/* 收起态红点挂图标右上角（原位置的文字让位了） */}
                {collapsed && showBadge && (
                  <span
                    aria-label="有新的财务洞察通知"
                    className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-danger dark:bg-danger-dark"
                  />
                )}
              </span>
              {!collapsed && (
                <>
                  <span className="truncate flex-1">{it.label}</span>
                  {showBadge && (
                    <span
                      aria-label="有新的财务洞察通知"
                      className="flex-none w-2 h-2 rounded-full bg-danger dark:bg-danger-dark"
                    />
                  )}
                </>
              )}
            </NavLink>
          );
        })}
      </nav>

      {/* Settings & profile：折叠切换按钮放设置上方（桌面专属；移动端不传 onToggleCollapse 自然隐藏） */}
      <div
        className={clsx(
          'pt-2 pb-3 border-t border-border dark:border-border-dark space-y-1',
          collapsed ? 'px-2.5' : 'px-3',
        )}
      >
        {onToggleCollapse && (
          <button
            type="button"
            onClick={onToggleCollapse}
            title={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            aria-label={collapsed ? '展开侧边栏' : '折叠侧边栏'}
            className={clsx(
              'flex items-center rounded-xl text-sm text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark transition',
              collapsed ? 'w-9 h-9 justify-center' : 'w-full gap-2.5 h-9 px-3',
            )}
          >
            {collapsed ? (
              <IconLayoutSidebarLeftExpand size={18} />
            ) : (
              <IconLayoutSidebarLeftCollapse size={18} />
            )}
            {!collapsed && <span>折叠</span>}
          </button>
        )}
        <button
          type="button"
          onClick={onNavigateSettings}
          title={collapsed ? '设置' : undefined}
          className={clsx(
            'flex items-center rounded-xl text-sm text-text-muted hover:bg-bg dark:hover:bg-bg-dark hover:text-text dark:hover:text-text-dark transition',
            collapsed ? 'w-9 h-9 justify-center' : 'w-full gap-2.5 h-9 px-3',
          )}
        >
          <IconSettings size={18} />
          {!collapsed && <span>设置</span>}
        </button>
        {/* 收起态名片隐藏（rail 宽度放不下，空间名仍在展开态与弹层里可达） */}
        {!collapsed && (
          <div className="flex items-center gap-2 px-2 pt-1">
            {/* ponytail: 头像占位中性化（Wave B），原粉→紫渐变是历史 palette 残留，与品牌炭黑极简语言不一致 */}
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-text-muted to-text flex-none" />
            <div className="text-xs text-text-muted truncate">{currentSpaceName}</div>
          </div>
        )}
      </div>
    </>
  );
}

/* ─────────────────── SpaceSwitcher 子组件 ─────────────────── */

interface SpaceSwitcherProps {
  spaces: Space[];
  spaceId: number;
  onPick: (id: number) => void;
  /** 新建成功后重新拉取 GET /api/spaces */
  onRefreshSpaces: () => void;
  /** 收起态：头部退化为单个 icon 按钮，弹层改为向右飞出（rail 内放不下原宽度） */
  collapsed?: boolean;
}

function SpaceSwitcher({ spaces, spaceId, onPick, onRefreshSpaces, collapsed = false }: SpaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // 头部按钮的展示名
  const headerLabel = (() => {
    if (spaceId === ALL_SPACES_ID) return ALL_SPACES_LABEL;
    return spaces.find((s) => s.id === spaceId)?.name ?? ALL_SPACES_LABEL;
  })();

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
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
    setCreating(true);
    setCreateError(null);
    try {
      const created = await apiFetch<RestSpaceRow>('/api/spaces', 'POST', { name });
      onRefreshSpaces();
      if (created?.id != null) onPick(created.id);
      setNewName('');
      setAdding(false);
      setOpen(false);
    } catch (e) {
      // 失败（如 core 侧 409 重名）时保留输入并提示，不收起面板
      setCreateError(String(e));
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className={clsx('relative pt-4 pb-2', collapsed ? 'px-2.5' : 'px-3')}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={collapsed ? headerLabel : undefined}
        aria-label={collapsed ? `切换空间（当前：${headerLabel}）` : undefined}
        className={clsx(
          'flex items-center rounded-xl hover:bg-bg dark:hover:bg-bg-dark transition',
          collapsed
            ? 'w-9 h-9 justify-center mx-auto'
            : 'w-full justify-between gap-2 h-10 px-3',
        )}
      >
        <div className={clsx('flex items-center min-w-0', !collapsed && 'gap-2')}>
          <div className="w-7 h-7 rounded-lg bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark flex items-center justify-center flex-none">
            <IconLayersIntersect size={14} />
          </div>
          {!collapsed && <span className="text-sm font-medium truncate">{headerLabel}</span>}
        </div>
        {!collapsed && <IconChevronDown size={14} className="text-text-muted" />}
      </button>

      {open && (
        // 收起态弹层飞出 rail 右侧（aside 无 overflow 裁剪，z-30 压主内容）；
        // 展开态保持原下拉形态
        <div
          className={clsx(
            'absolute z-30 card !p-1 !rounded-xl',
            collapsed ? 'left-full top-0 ml-2 w-56' : 'left-3 right-3 mt-1',
          )}
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
              onClick={() => {
                setAdding(true);
                setCreateError(null);
              }}
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
                onChange={(e) => {
                  setNewName(e.target.value);
                  if (createError) setCreateError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void handleCreate();
                  } else if (e.key === 'Escape') {
                    setAdding(false);
                    setNewName('');
                    setCreateError(null);
                  }
                }}
                placeholder="空间名称"
                maxLength={20}
                className="w-full h-8 px-2 rounded-lg bg-bg dark:bg-bg-dark border border-border dark:border-border-dark text-sm focus:outline-none focus:ring-2 focus:ring-brand/40"
              />
              {createError && (
                <div className="text-xs text-expense break-words">{createError}</div>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAdding(false);
                    setNewName('');
                    setCreateError(null);
                  }}
                  className="flex-1 h-7 rounded-lg text-xs text-text-muted hover:bg-bg dark:hover:bg-bg-dark"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreate()}
                  disabled={!newName.trim() || creating}
                  className={clsx(
                    'flex-1 h-7 rounded-lg text-xs font-medium transition',
                    newName.trim() && !creating
                      ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                      : 'bg-bg dark:bg-bg-dark text-text-muted cursor-not-allowed',
                  )}
                >
                  {creating ? '创建中…' : '创建'}
                </button>
              </div>
            </div>
          )}

          {/* 描述 / 统计 */}
          <div className="px-3 pt-2 pb-1 text-[0.625rem] text-text-muted leading-relaxed">
            {spaceId === ALL_SPACES_ID
              ? ALL_SPACES_DESC
              : `当前仅展示「${headerLabel}」中的数据`}
          </div>
        </div>
      )}
    </div>
  );
}