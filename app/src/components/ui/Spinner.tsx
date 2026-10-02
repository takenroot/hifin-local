/**
 * 加载指示器（极简）
 * ---------------------------------------------------------------
 * 列表页在数据到达前用它占位，替代"空状态"那一帧：
 * - 圆环用语义 token 描边，亮/暗成对（border-border / border-border-dark），
 *   旋转弧用 text / text-dark，保证暗色下同样可见；
 * - 默认不渲染可见文字（label 省略时只有 sr-only 提示），
 *   需要就地说明时传 label。
 */
import clsx from 'clsx';

export interface SpinnerProps {
  /** 圆环直径（px），默认 16 */
  size?: number;
  /** 圆环旁可见文字；省略时仅保留屏幕阅读器提示 */
  label?: string;
  className?: string;
}

export function Spinner({ size = 16, label, className }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="spinner"
      className={clsx(
        'inline-flex items-center gap-2 text-sm text-text-muted dark:text-text-muted-dark',
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="inline-block flex-none rounded-full border-2 animate-spin border-border dark:border-border-dark border-t-text dark:border-t-text-dark"
        style={{ width: size, height: size }}
      />
      {label ? <span>{label}</span> : <span className="sr-only">加载中</span>}
    </span>
  );
}
