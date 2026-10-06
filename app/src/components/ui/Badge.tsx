import type { ReactNode } from 'react';
import clsx from 'clsx';

export type BadgeTone = 'neutral' | 'income' | 'expense' | 'brand' | 'warning';

export interface BadgeProps {
  tone?: BadgeTone;
  children: ReactNode;
  className?: string;
}

const toneClass: Record<BadgeTone, string> = {
  neutral: 'bg-bg dark:bg-bg-card-dark text-text-muted',
  income: 'bg-income-soft dark:bg-income-soft-dark text-income',
  expense: 'bg-expense-soft dark:bg-expense-soft-dark text-expense',
  brand: 'bg-brand-soft text-brand',
  // ponytail: warning token 化（Wave B），避免硬编码 yellow-* 调色板与品牌炭黑极简语言打架
  warning: 'bg-warning-soft dark:bg-warning-soft-dark text-warning',
};

export function Badge({ tone = 'neutral', children, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 h-5 text-xs rounded-md whitespace-nowrap',
        toneClass[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
