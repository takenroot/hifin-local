/**
 * SidebarCollapseHandle — 边缘折叠手柄（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 桌面 aside 的右边缘浮一颗圆按钮，半悬于 rail 边线外：
 *   - 展开态：IconChevronLeft（指向左 = "往左收"）
 *   - 收起态：IconChevronRight（指向右 = "往右展"）
 * hover scale-110 放大一点；title + aria-label 齐全。
 *
 * ponytail: 这是个"按钮"不是"组件"——业务方唯一用途是切换 sidebarCollapsedAtom，
 * 自己接 useAtom 会让这个组件变成"业务耦合"。这里保留 props.onToggle，由父级
 * AppLayout 注入 — AppLayout 已经在管那个 atom，避免重复订阅。
 */
import clsx from 'clsx';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

interface SidebarCollapseHandleProps {
  collapsed: boolean;
  onToggle: () => void;
}

export function SidebarCollapseHandle({ collapsed, onToggle }: SidebarCollapseHandleProps) {
  const label = collapsed ? '展开侧边栏' : '折叠侧边栏';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      // 桌面专属：移动端不渲染（父级 aside 用 hidden lg:flex 包住）
      className={clsx(
        'absolute right-0 top-1/2 -translate-y-1/2 translate-x-1/2 z-20',
        'w-6 h-6 rounded-full bg-bg-card dark:bg-bg-card-dark',
        'border border-border dark:border-border-dark shadow-soft dark:shadow-soft-dark',
        'flex items-center justify-center text-text-muted',
        'hover:text-text dark:hover:text-text-dark hover:scale-110 transition',
      )}
    >
      {collapsed ? <IconChevronRight size={14} /> : <IconChevronLeft size={14} />}
    </button>
  );
}
