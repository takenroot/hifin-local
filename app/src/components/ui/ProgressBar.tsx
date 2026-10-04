import { useEffect, useRef, useState } from 'react';
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
  // 宽度动画走 transform（合成层，不触发布局）；will-change 只在值真的变了、
  // 动画真的在跑的那段时间挂着，transitionend 后撤掉
  const prev = useRef(v);
  const [animating, setAnimating] = useState(false);
  useEffect(() => {
    if (prev.current === v) return;
    prev.current = v;
    setAnimating(true);
  }, [v]);

  return (
    <div className={clsx('flex items-center gap-3', className)}>
      <div
        className={clsx(
          'flex-1 rounded-full bg-bg dark:bg-bg-card-dark overflow-hidden',
          size === 'sm' ? 'h-1.5' : 'h-2',
        )}
      >
        <div
          className={clsx(
            'h-full w-full rounded-full origin-left transition-transform motion-reduce:transition-none',
            toneClass[tone],
          )}
          style={{ transform: `scaleX(${v / 100})`, willChange: animating ? 'transform' : undefined }}
          onTransitionEnd={() => setAnimating(false)}
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
