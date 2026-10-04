import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
}

const variantClass: Record<ButtonVariant, string> = {
  // primary = 品牌靛蓝（2026-10-05 用户决策，替代近黑 bg-text）
  primary: 'bg-brand text-white hover:opacity-90 disabled:opacity-40',
  secondary:
    'bg-bg-card dark:bg-bg-card-dark text-text dark:text-text-dark border border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
  ghost: 'text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark',
  danger: 'bg-expense text-white hover:opacity-90',
};

const sizeClass: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-sm rounded-lg gap-1.5',
  md: 'h-10 px-4 text-sm rounded-xl gap-2',
  lg: 'h-12 px-6 text-base rounded-2xl gap-2',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    block,
    icon,
    iconRight,
    className,
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      className={clsx(
        'inline-flex items-center justify-center font-medium transition select-none',
        // 触觉反馈：transform 走合成层，transition 已含 transform 属性；
        // motion-safe 前缀让 prefers-reduced-motion 用户拿不到缩放
        'motion-safe:active:scale-[0.97]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
        variantClass[variant],
        sizeClass[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  );
});
