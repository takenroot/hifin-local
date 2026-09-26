import { forwardRef, type TextareaHTMLAttributes } from 'react';
import clsx from 'clsx';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { invalid, className, ...rest },
  ref,
) {
  return (
    <textarea
      ref={ref}
      className={clsx(
        'w-full min-h-[80px] p-3 rounded-xl border bg-bg-card dark:bg-bg-card-dark text-sm',
        'border-border dark:border-border-dark outline-none resize-y',
        'focus:ring-2 focus:ring-brand/40 placeholder:text-text-muted',
        invalid && 'border-expense ring-2 ring-expense/30',
        className,
      )}
      {...rest}
    />
  );
});
