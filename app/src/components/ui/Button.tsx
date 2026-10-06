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
  // primary = 炭黑（2026-10-06 主题还原决策，对齐复刻源极简语言；brand 令牌已指向 #26262b）
  primary: 'bg-brand text-white hover:opacity-90 disabled:opacity-40',
  secondary:
    'bg-bg-card dark:bg-bg-card-dark text-text dark:text-text-dark border border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
  ghost: 'text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark',
  // danger 走状态轴（与金额语义正交），不吃 expense/income 令牌
  danger: 'bg-danger text-white hover:opacity-90',
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
    style,
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
        // 触觉反馈（2026-10-06 bento-motion §4）：scale(0.98) + 120ms --dur-press。
        // motion-safe 前缀让 prefers-reduced-motion 用户拿不到缩放——reduced-motion
        // 仍保留颜色/阴影过渡（focus-visible 环），只是不位移（Emil Kowalski：
        // reduced = 更少更温和，非零）。
        'motion-safe:active:scale-[0.98]',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/50',
        variantClass[variant],
        sizeClass[size],
        block && 'w-full',
        className,
      )}
      // transition-duration 显式覆盖 Tailwind 的 150ms 默认：press 用 --dur-press=120ms
      // 是有意的，0.97→0.98 一档差更轻，120ms 防止"按下去又弹回"的颤动。
      style={{ transitionDuration: 'var(--dur-press)', ...style }}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </button>
  );
});
