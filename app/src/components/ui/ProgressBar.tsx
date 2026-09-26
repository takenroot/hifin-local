import clsx from 'clsx';

export interface ProgressBarProps {
  /** 0 ~ 100 */
  value: number;
  /** 主题色 */
  tone?: 'income' | 'expense' | 'brand' | 'neutral';
  size?: 'sm' | 'md';
  showLabel?: boolean;
  className?: string;
}

const toneClass = {
  income: 'bg-income',
  expense: 'bg-expense',
  brand: 'bg-brand',
  neutral: 'bg-text-muted',
} as const;

export function ProgressBar({
  value,
  tone = 'income',
  size = 'md',
  showLabel,
  className,
}: ProgressBarProps) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <div
        className={clsx(
          'flex-1 rounded-full bg-bg dark:bg-bg-card-dark overflow-hidden',
          size === 'sm' ? 'h-1.5' : 'h-2',
        )}
      >
        <div
          className={clsx('h-full rounded-full transition-all', toneClass[tone])}
          style={{ width: `${v}%` }}
        />
      </div>
      {showLabel && (
        <div className="text-xs text-text-muted w-10 text-right tabular-nums">
          {v.toFixed(0)}%
        </div>
      )}
    </div>
  );
}
