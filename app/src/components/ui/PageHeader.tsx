import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  /** 页面标题 */
  title: ReactNode;
  /** 副标题/描述 */
  description?: ReactNode;
  /** 右上角快捷操作（按钮组） */
  actions?: ReactNode;
  /** 标题旁的图标（如 📊） */
  icon?: ReactNode;
  /** 标题语义级别：页面级传 h1，嵌套子标题传 h2，纯视觉标题传 div */
  titleLevel?: 'h1' | 'h2' | 'div';
  className?: string;
}

/**
 * 页面标题栏：左侧图标+标题+描述，右侧快捷操作槽位。
 * 与 Tailwind 默认行为兼容，可被任意 page 顶部直接使用。
 */
export function PageHeader({
  title,
  description,
  actions,
  icon,
  titleLevel = 'h1',
  className,
}: PageHeaderProps) {
  const Title = titleLevel;
  return (
    <header
      className={clsx(
        'flex items-center justify-between gap-4 px-4 lg:px-8 h-16 border-b border-border dark:border-border-dark',
        className,
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        {icon && <div className="text-text-muted">{icon}</div>}
        <div className="min-w-0">
          <Title className="text-base font-medium text-text dark:text-text-dark truncate">
            {title}
          </Title>
          {description && (
            <div className="text-xs text-text-muted truncate">{description}</div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-none">{actions}</div>
    </header>
  );
}
