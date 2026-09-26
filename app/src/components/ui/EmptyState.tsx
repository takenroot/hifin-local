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

/**
 * 内置手绘风格空状态插画：账本 + 钱包 + 硬币
 * - line / stroke 风格，fill="none"，统一 currentColor，配合父级
 *   text-border dark:text-border-dark 在 light/dark 下自适应。
 * - 尺寸 ~200x160，viewBox 200x160 以保证矢量清晰。
 */
function DefaultIllustration() {
  return (
    <svg
      width="200"
      height="160"
      viewBox="0 0 200 160"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-border dark:text-border-dark"
      aria-hidden="true"
    >
      {/* 背景柔光圆（强调视觉中心，纯描边） */}
      <circle cx="100" cy="78" r="58" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 4" opacity="0.55" />

      {/* 账本底座（轻微透视矩形） */}
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* 账本封面 */}
        <path d="M44 64 L100 50 L156 64 L156 122 L100 136 L44 122 Z" />
        {/* 账本厚度 / 内页分隔线 */}
        <path d="M44 64 L100 78 L156 64" />
        <path d="M100 78 L100 136" opacity="0.85" />

        {/* 账本装订线 */}
        <path d="M52 66 L52 120 M56 65 L56 121 M60 64 L60 122" opacity="0.7" />
        <path d="M140 66 L140 120 M144 65 L144 121 M148 64 L148 122" opacity="0.7" />

        {/* 账本内页横线（待记内容） */}
        <path d="M68 86 L92 90" opacity="0.55" />
        <path d="M68 96 L88 99" opacity="0.55" />
        <path d="M68 106 L94 110" opacity="0.55" />
        <path d="M108 86 L132 90" opacity="0.55" />
        <path d="M108 96 L128 99" opacity="0.55" />
        <path d="M108 106 L134 110" opacity="0.55" />
      </g>

      {/* 钱包（悬浮在账本上） */}
      <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
        {/* 钱包主体 */}
        <rect x="118" y="38" width="58" height="38" rx="6" />
        {/* 钱包翻盖 */}
        <path d="M118 50 L176 50" />
        {/* 钱包扣 */}
        <rect x="148" y="54" width="14" height="6" rx="2" />
        {/* 钱包内露出的卡片 */}
        <path d="M128 42 L150 42" opacity="0.7" />
      </g>

      {/* 飘落的硬币（右上） */}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <circle cx="178" cy="22" r="6" />
        <path d="M178 18 L178 26 M174 22 L182 22" opacity="0.85" />
        <circle cx="168" cy="14" r="2.5" opacity="0.7" />
      </g>

      {/* 飘落的小纸币（左上） */}
      <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none">
        <path d="M22 28 L40 22 L44 30 L26 36 Z" />
        <path d="M30 28 L36 26" opacity="0.75" />
        <circle cx="34" cy="32" r="1.5" opacity="0.7" />
      </g>

      {/* 底部装饰小点（呼吸感） */}
      <g fill="currentColor" opacity="0.5">
        <circle cx="28" cy="118" r="1.4" />
        <circle cx="38" cy="128" r="1.2" />
        <circle cx="22" cy="140" r="1.2" />
        <circle cx="172" cy="128" r="1.4" />
        <circle cx="180" cy="140" r="1.2" />
        <circle cx="164" cy="142" r="1.1" />
      </g>

      {/* 地面阴影线（极简） */}
      <path d="M58 146 L142 146" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="3 5" opacity="0.5" />
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
        <div className="mt-2 text-sm text-text-muted dark:text-text-muted-dark max-w-sm whitespace-pre-line">
          {description}
        </div>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}