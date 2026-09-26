import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface TabItem {
  key: string;
  label: ReactNode;
  /** 自定义渲染内容；不传则需要 children */
  content?: ReactNode;
  disabled?: boolean;
}

export interface TabsProps {
  items: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
  /** 渲染方式：line 下划线 / pill 胶囊 */
  variant?: 'line' | 'pill';
  className?: string;
}

export function Tabs({
  items,
  activeKey,
  onChange,
  variant = 'line',
  className,
}: TabsProps) {
  return (
    <div className={clsx('flex items-center gap-1', className)}>
      {items.map((it) => {
        const active = it.key === activeKey;
        return (
          <button
            key={it.key}
            type="button"
            disabled={it.disabled}
            onClick={() => !it.disabled && onChange(it.key)}
            className={clsx(
              'h-8 px-3 text-sm rounded-lg transition',
              variant === 'pill'
                ? active
                  ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                  : 'text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark'
                : 'border-b-2 -mb-px',
              variant === 'line' &&
                (active
                  ? 'border-text dark:border-bg-card text-text dark:text-text-dark'
                  : 'border-transparent text-text-muted hover:text-text dark:hover:text-text-dark'),
              it.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
