import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  prefix?: ReactNode;
  suffix?: ReactNode;
  invalid?: boolean;
  block?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { prefix, suffix, invalid, block = true, className, ...rest },
  ref,
) {
  return (
    <div
      className={clsx(
        'flex items-center gap-2 h-10 px-3 rounded-xl border bg-bg-card dark:bg-bg-card-dark',
        'border-border dark:border-border-dark',
        'focus-within:ring-2 focus-within:ring-brand/40',
        invalid && 'border-expense ring-2 ring-expense/30',
        block && 'w-full',
        className,
      )}
    >
      {prefix && <span className="text-text-muted">{prefix}</span>}
      <input
        ref={ref}
        className="flex-1 bg-transparent outline-none text-sm placeholder:text-text-muted"
        {...rest}
      />
      {suffix && <span className="text-text-muted">{suffix}</span>}
    </div>
  );
});
