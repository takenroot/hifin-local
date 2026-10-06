/**
 * SidebarTools — 侧边栏工具排（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 4 件套：调色盘 / 日夜切换 / 通知 / 头像入口。
 * flex 横排 gap-1；折叠态整排 icon-only 居中（title 提供 tooltip）。
 *
 * ponytail: 4 个按钮彼此独立 —— 不需要"工具排容器"做什么联动；这里只是个
 * 排版容器，flex + gap-1 就够。头像在桌面是路由入口，不展开二级菜单。
 */
import { useNavigate } from 'react-router-dom';
import { AccentPicker } from './AccentPicker';
import { NotificationBell } from './NotificationBell';
import { ThemeToggle } from './ThemeToggle';

interface SidebarToolsProps {
  collapsed?: boolean;
}

export function SidebarTools({ collapsed = false }: SidebarToolsProps) {
  const navigate = useNavigate();

  return (
    <div
      className={`flex items-center gap-1 ${
        collapsed ? 'justify-center px-2.5' : 'justify-start px-3'
      }`}
    >
      <AccentPicker collapsed={collapsed} />
      <ThemeToggle collapsed={collapsed} />
      <NotificationBell collapsed={collapsed} />
      <button
        type="button"
        onClick={() => navigate('/settings')}
        title={collapsed ? '设置' : undefined}
        aria-label="设置"
        className="flex items-center justify-center w-9 h-9 rounded-xl text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-dark transition"
      >
        {/* ponytail: 中性化头像占位（原粉→紫渐变是历史 palette 残留，与炭黑极简语言不一致） */}
        <span
          aria-hidden
          className="w-6 h-6 rounded-full bg-gradient-to-br from-text-muted to-text dark:from-text-muted-dark dark:to-text-dark"
        />
      </button>
    </div>
  );
}
