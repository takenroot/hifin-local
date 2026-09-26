import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  /** 标题文字 */
  title: ReactNode;
  /** 描述文字 */
  description?: ReactNode;
  /** 主操作按钮区 */
  action?: ReactNode;
  /** 自定义插画；不传则使用内置 SVG */
  illustration?: ReactNode;
  className?: string;
}

/** 内置简洁 SVG 插画（空盒） */
function DefaultIllustration() {
  return (
    <svg
      width="160"
      height="120"
      viewBox="0 0 160 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-border dark:text-border-dark"
    >
      <rect
        x="20"
        y="40"
        width="120"
        height="70"
        rx="10"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="4 4"
      />
      <path
        d="M20 60 L80 40 L140 60"
        stroke="currentColor"
        strokeWidth="2"
        strokeDasharray="4 4"
      />
      <path
        d="M70 25 Q80 15 90 25 L80 35 Z"
        stroke="currentColor"
        strokeWidth="2"
        fill="none"
      />
      <line x1="55" y1="80" x2="105" y2="80" stroke="currentColor" strokeWidth="2" />
      <line x1="55" y1="92" x2="95" y2="92" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

export function EmptyState({
  title,
  description,
  action,
  illustration,
  className,
}: EmptyStateProps) {
  return (
    <div className={clsx('flex flex-col items-center justify-center py-16 px-6 text-center', className)}>
      <div className="mb-6 opacity-90">{illustration ?? <DefaultIllustration />}</div>
      <div className="text-base font-medium text-text dark:text-text-dark">{title}</div>
      {description && (
        <div className="mt-2 text-sm text-text-muted max-w-sm whitespace-pre-line">
          {description}
        </div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
