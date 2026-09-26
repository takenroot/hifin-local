import clsx from 'clsx';

export interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}

export function Switch({
  checked,
  onChange,
  disabled,
  size = 'md',
  className,
}: SwitchProps) {
  const sz = size === 'sm' ? 'w-8 h-5' : 'w-10 h-6';
  const dot = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const offset = size === 'sm' ? (checked ? 'translate-x-3.5' : 'translate-x-0.5') : checked ? 'translate-x-4' : 'translate-x-1';

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={clsx(
        sz,
        'rounded-full transition-colors relative inline-flex items-center flex-none',
        checked ? 'bg-text dark:bg-bg-card' : 'bg-border dark:bg-border-dark',
        disabled && 'opacity-40 cursor-not-allowed',
        className,
      )}
    >
      <span
        className={clsx(
          dot,
          'bg-bg-card dark:bg-bg-dark rounded-full transition-transform shadow',
          offset,
        )}
      />
    </button>
  );
}
