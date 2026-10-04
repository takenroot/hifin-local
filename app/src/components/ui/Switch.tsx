import clsx from 'clsx';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
  /** 无可见文字标签时（如图标行内的开关）必须给出，否则读屏只报"开关" */
  'aria-label'?: string;
  /** 已有可见 <label> 时用 id 关联，优先于 aria-label */
  'aria-labelledby'?: string;
}

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  className,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
}: SwitchProps) {
  const sz = size === 'sm' ? 'w-8 h-5' : 'w-10 h-6';
  const dot = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const offset = size === 'sm' ? (checked ? 'translate-x-3.5' : 'translate-x-0.5') : checked ? 'translate-x-4' : 'translate-x-1';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledBy}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        sz,
        'rounded-full transition-colors relative inline-flex items-center flex-none',
        // 开启态用品牌靛蓝：原先 dark:bg-bg-card 在同色卡片底上只有 ~1.09:1，轨道等于消失
        checked ? 'bg-brand' : 'bg-border dark:bg-border-dark',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      <span
        className={clsx(
          dot,
          'bg-bg-card dark:bg-bg-dark rounded-full transition-transform shadow',
          offset,
        )}
      />
    </button>
  );
}
