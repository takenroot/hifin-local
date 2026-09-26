import { forwardRef, type SelectHTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';
import { IconChevronDown } from '@tabler/icons-react';

export interface SelectOption {
  label: string;
  value: string | number;
  disabled?: boolean;
}

export interface SelectProps
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children' | 'prefix'> {
  options: SelectOption[];
  prefix?: ReactNode;
  placeholder?: string;
  block?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, prefix, placeholder, block = true, className, ...rest },
  ref,
) {
  return (
    <div
      className={clsx(
        'flex items-center gap-2 h-10 px-3 rounded-xl border bg-bg-card dark:bg-bg-card-dark',
        'border-border dark:border-border-dark focus-within:ring-2 focus-within:ring-brand/40',
        block && 'w-full',
        className,
      )}
    >
      {prefix && <span className="text-text-muted">{prefix}</span>}
      <select
        ref={ref}
        className="flex-1 bg-transparent outline-none text-sm appearance-none cursor-pointer"
        {...rest}
      >
        {placeholder !== undefined && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      <IconChevronDown size={16} className="text-text-muted" />
    </div>
  );
});
