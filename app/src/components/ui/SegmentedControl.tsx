/**
 * SegmentedControl —— 分段控件（日/周/月/年、支出/收入这类 2~4 档互斥切换）
 * ---------------------------------------------------------------
 * 为什么不用 Tabs variant="pill"：
 *   pill 档的选中态写死成 `bg-text / dark:bg-bg-card-dark`。放到暗色容器里时
 *   选中块与容器同色（#171a21），只能靠字色区分，选中态几乎不可见。
 *   本组件让暗色下选中块翻成浅色（bg-text-dark），明暗两侧都保持"实心块 = 选中"。
 *
 * 视觉约定：容器用 bg-bg / bg-bg-card-dark + border-border / border-border-dark，
 * 文字用 text-text / text-text-muted-dark 语义 token，不写死颜色。
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface SegmentedOption<T extends string> {
  key: T;
  label: ReactNode;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  options: SegmentedOption<T>[];
  /** 当前选中档位 */
  value: T;
  onChange: (key: T) => void;
  className?: string;
  /** a11y：控件名称 */
  'aria-label'?: string;
}

export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={clsx(
        'inline-flex items-center gap-1 p-1 rounded-xl',
        'bg-bg dark:bg-bg-card-dark',
        'border border-border dark:border-border-dark',
        className,
      )}
    >
      {options.map((opt) => {
        const active = opt.key === value;
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={opt.disabled}
            onClick={() => !opt.disabled && onChange(opt.key)}
            className={clsx(
              'h-8 px-3 text-sm rounded-lg transition whitespace-nowrap',
              active
                ? 'bg-text text-bg-card dark:bg-text-dark dark:text-bg-card-dark font-medium'
                : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg-card dark:hover:bg-bg-card-dark',
              opt.disabled && 'opacity-40 cursor-not-allowed',
            )}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default SegmentedControl;
