import { forwardRef, type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** 是否取消内边距（用于纯布局卡片） */
  flush?: boolean;
  title?: ReactNode;
  extra?: ReactNode;
}

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { flush, title, extra, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={clsx(
        'card',
        !flush && 'p-6',
        className,
      )}
      {...rest}
    >
      {(title || extra) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <div className="text-base font-medium text-text dark:text-text-dark">{title}</div>}
          {extra}
        </div>
      )}
      {children}
    </div>
  );
});
