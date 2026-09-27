/**
 * 自定义下拉组件
 * ---------------------------------------------------------------
 * 完全自写：触发器（button）+ 放大器（绝对定位卡片）。无原生 <select>。
 *
 * API 与旧实现保持向后兼容：
 *   - options / value / onChange / placeholder / block / disabled / prefix / className
 *   - onChange 形参签名保持为 ({ target: { value: string } }) => void，
 *     调用方原有 `e.target.value` / `e.target.value === ''` 等用法不受影响。
 *   - value 可为 string | number（受控；placeholder 时传 ''）。
 *
 * 交互：
 *   - 点击触发器切换开合；点击外部 / Esc 关闭；
 *   - ↑↓ 上下选择当前高亮项，回车选中，Home/End 跳到首尾；
 *   - opt.disabled 灰化且不可点；
 *   - block=true 触发器占满父宽；block=false 按内容自适应。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import { IconCheck, IconChevronDown } from '@tabler/icons-react';

export interface SelectOption {
  label: string;
  value: string | number;
  disabled?: boolean;
}

export interface SelectProps {
  options: SelectOption[];
  /** 受控值（string | number）。未选中时传 ''，placeholder 占位行才会显示。 */
  value?: string | number;
  /** 与原生 select 一致：签名 ({ target: { value: string } }) => void */
  onChange?: (e: { target: { value: string; name?: string } }) => void;
  /** 未选中时显示在触发器里的浅灰提示文本 */
  placeholder?: string;
  /** true 时触发器占满父宽；false 时按内容自适应（默认 true） */
  block?: boolean;
  /** 触发器左侧小图标 */
  prefix?: ReactNode;
  /** 透传 <select> 字段名（用于原生表单提交） */
  name?: string;
  /** 透传 id，便于 <label htmlFor> */
  id?: string;
  /** 整体禁用 */
  disabled?: boolean;
  /** 透传 className 到最外层容器 */
  className?: string;
  /** a11y：弹出层标签 */
  'aria-label'?: string;
}

/** 把任意 value 归一为字符串，方便比较 / 回填 onChange */
function toStr(v: string | number | undefined): string {
  return v === undefined || v === null ? '' : String(v);
}

export const Select = forwardRef<HTMLButtonElement, SelectProps>(function Select(
  {
    options,
    value,
    onChange,
    placeholder,
    block = true,
    prefix: prefixNode,
    name,
    id,
    disabled,
    className,
    'aria-label': ariaLabel,
  },
  ref,
) {
  const reactId = useId();
  const listboxId = `hifin-select-listbox-${reactId}`;
  const triggerId = id ?? `hifin-select-trigger-${reactId}`;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 合并 forwardRef + 内部 ref
  const setTriggerRef = useCallback(
    (el: HTMLButtonElement | null) => {
      triggerRef.current = el;
      if (typeof ref === 'function') ref(el);
      else if (ref) {
        (ref as React.MutableRefObject<HTMLButtonElement | null>).current = el;
      }
    },
    [ref],
  );

  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState<number>(-1);
  // 弹层方向：'down' 默认在下方，'up' 空间不够时翻转
  const [placement, setPlacement] = useState<'down' | 'up'>('down');

  const strValue = toStr(value);
  const selectedIdx = useMemo(
    () => options.findIndex((o) => toStr(o.value) === strValue),
    [options, strValue],
  );
  const selectedOption = selectedIdx >= 0 ? options[selectedIdx] : undefined;

  /** 计算弹层方向：若下方空间 < 240px 且上方空间更大，则向上 */
  const recomputePlacement = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const spaceBelow = window.innerHeight - rect.bottom - 8;
    const spaceAbove = rect.top - 8;
    const needed = 240;
    if (spaceBelow < needed && spaceAbove > spaceBelow) {
      setPlacement('up');
    } else {
      setPlacement('down');
    }
  }, []);

  // 打开时计算一次（弹层尺寸稳定后），并监听 resize / scroll 重算
  useLayoutEffect(() => {
    if (!open) return;
    recomputePlacement();
    const handler = () => recomputePlacement();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, recomputePlacement]);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (containerRef.current && !containerRef.current.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // 打开后默认高亮当前选中项；没有选中项时高亮第一个非 disabled 项
  useEffect(() => {
    if (!open) return;
    let idx = selectedIdx;
    if (idx < 0 || options[idx]?.disabled) {
      idx = options.findIndex((o) => !o.disabled);
    }
    setActiveIdx(idx);
    // 等待 DOM 渲染完再滚动到可见位置
    const t = window.setTimeout(() => {
      const list = listRef.current;
      if (!list || idx < 0) return;
      const item = list.querySelector<HTMLButtonElement>(
        `[data-idx="${idx}"]`,
      );
      item?.scrollIntoView({ block: 'nearest' });
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, options, selectedIdx]);

  const commit = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (!opt || opt.disabled) return;
      const next = toStr(opt.value);
      setOpen(false);
      // 触发器失焦；触发 ref 当前版本
      triggerRef.current?.focus();
      onChange?.({ target: { value: next, name } });
    },
    [options, onChange, name],
  );

  const onTriggerClick = useCallback(() => {
    if (disabled) return;
    setOpen((v) => !v);
  }, [disabled]);

  const onTriggerKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (disabled) return;
      if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!open) setOpen(true);
        return;
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault();
        setOpen(false);
      }
    },
    [disabled, open],
  );

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (!open) return;
      const enabledIdxs = options
        .map((o, i) => ({ o, i }))
        .filter((x) => !x.o.disabled)
        .map((x) => x.i);
      if (enabledIdxs.length === 0) return;
      const curPos = enabledIdxs.indexOf(activeIdx);

      const moveTo = (nextPos: number) => {
        const pos = Math.max(0, Math.min(enabledIdxs.length - 1, nextPos));
        const idx = enabledIdxs[pos];
        setActiveIdx(idx);
        const list = listRef.current;
        const item = list?.querySelector<HTMLButtonElement>(
          `[data-idx="${idx}"]`,
        );
        item?.scrollIntoView({ block: 'nearest' });
      };

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveTo(curPos < 0 ? 0 : curPos + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveTo(curPos < 0 ? enabledIdxs.length - 1 : curPos - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        moveTo(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        moveTo(enabledIdxs.length - 1);
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (activeIdx >= 0) commit(activeIdx);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      } else if (e.key === 'Tab') {
        // 允许 Tab 离开，自然关闭
        setOpen(false);
      }
    },
    [activeIdx, commit, open, options],
  );

  const showPlaceholder = selectedOption === undefined && placeholder !== undefined;
  const triggerLabel = selectedOption?.label ?? placeholder ?? '';

  return (
    <div
      ref={containerRef}
      className={clsx('relative', block ? 'w-full' : 'inline-block', className)}
    >
      <button
        ref={setTriggerRef}
        id={triggerId}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onTriggerClick}
        onKeyDown={onTriggerKeyDown}
        className={clsx(
          'flex items-center gap-2 h-10 px-3 rounded-xl border text-sm text-left transition',
          'bg-bg-card dark:bg-bg-card-dark',
          'border-border dark:border-border-dark',
          'focus:outline-none focus:ring-2 focus:ring-brand/40',
          block ? 'w-full' : 'min-w-[8rem]',
          disabled && 'opacity-60 cursor-not-allowed',
          open && 'ring-2 ring-brand/40',
        )}
      >
        {prefixNode && (
          <span className="flex-none text-text-muted dark:text-text-muted-dark">
            {prefixNode}
          </span>
        )}
        <span
          className={clsx(
            'flex-1 truncate',
            showPlaceholder
              ? 'text-text-muted dark:text-text-muted-dark'
              : 'text-text dark:text-text-dark',
          )}
        >
          {triggerLabel}
        </span>
        <IconChevronDown
          size={16}
          className={clsx(
            'flex-none text-text-muted dark:text-text-muted-dark transition-transform',
            open && 'rotate-180',
          )}
        />
      </button>

      {open && (
        <div
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={-1}
          onKeyDown={onListKeyDown}
          className={clsx(
            'absolute left-0 right-0 z-50 rounded-xl border shadow-soft dark:shadow-soft-dark',
            'bg-bg-card dark:bg-bg-card-dark',
            'border-border dark:border-border-dark',
            'max-h-60 overflow-y-auto py-1',
            'focus:outline-none',
            placement === 'down' ? 'top-full mt-1' : 'bottom-full mb-1',
          )}
        >
          {options.length === 0 && (
            <div className="px-3 py-2 text-sm text-text-muted dark:text-text-muted-dark">
              无可选项
            </div>
          )}
          {options.map((opt, idx) => {
            const isSelected = idx === selectedIdx;
            const isActive = idx === activeIdx;
            return (
              <button
                key={`${opt.value}-${idx}`}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-disabled={opt.disabled || undefined}
                data-idx={idx}
                disabled={opt.disabled}
                onMouseEnter={() => {
                  if (!opt.disabled) setActiveIdx(idx);
                }}
                onClick={() => commit(idx)}
                className={clsx(
                  'w-full flex items-center gap-2 px-3 h-9 text-sm text-left transition',
                  opt.disabled
                    ? 'text-text-muted dark:text-text-muted-dark cursor-not-allowed'
                    : clsx(
                        'text-text dark:text-text-dark cursor-pointer',
                        isActive &&
                          'bg-bg dark:bg-bg-dark',
                      ),
                  isSelected && !opt.disabled && 'font-medium',
                )}
              >
                <span className="flex-1 truncate">{opt.label}</span>
                {isSelected && (
                  <IconCheck
                    size={14}
                    className="flex-none text-brand"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
});

export default Select;