import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconX } from '@tabler/icons-react';

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  /** 自定义宽度（默认 480） */
  width?: number | string;
  /** 显示底部区域 */
  footer?: ReactNode;
  children?: ReactNode;
  /** 隐藏右上角关闭按钮 */
  hideClose?: boolean;
}

/** Tab 焦点循环的可聚焦元素（不把 tabindex="-1" 与 disabled 算进来） */
const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

function focusables(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
}

/**
 * 通用居中模态框。父组件控制 open；通过 portal 渲染到 body。
 * 也可作为分步模态（footer / children 自定义）。
 */
export function Modal({
  open,
  onClose,
  title,
  width = 480,
  footer,
  children,
  hideClose,
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  /* 键盘：Esc 关闭 + Tab 焦点循环。
     只依赖 [open]，onClose 用 ref 取，避免调用方内联箭头每次渲染都重建监听。 */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusables(panelRef.current);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // 焦点在面板外（初始状态或已丢失）时也要拉回循环内
      const outside = !panelRef.current?.contains(active);
      if (e.shiftKey ? active === first || outside : active === last || outside) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open]);

  /* 初始焦点落到第一个可交互元素；关闭后把焦点归还给触发元素。
     依赖只放 [open]：跟着 open 翻转跑一次，避免渲染抖动时反复抢焦点。 */
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    // 等一帧，等 children（如 async 内容）把可聚焦元素挂上来
    const raf = requestAnimationFrame(() => {
      focusables(panelRef.current)[0]?.focus();
    });
    return () => {
      cancelAnimationFrame(raf);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : '对话框'}
        className={clsx(
          'relative card max-h-[85vh] overflow-hidden flex flex-col max-w-[calc(100vw-2rem)]',
        )}
        style={{ width }}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div id={titleId} className="text-base font-medium text-text dark:text-text-dark">
              {title}
            </div>
            {!hideClose && (
              <button
                type="button"
                aria-label="关闭"
                onClick={onClose}
                className="text-text-muted hover:text-text dark:hover:text-text-dark p-1 rounded-lg hover:bg-bg dark:hover:bg-bg-card-dark"
              >
                <IconX size={18} />
              </button>
            )}
          </div>
        )}
        <div className="px-6 pb-5 overflow-auto">{children}</div>
        {footer && (
          <div className="px-6 py-4 border-t border-border dark:border-border-dark flex items-center justify-end gap-2">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
