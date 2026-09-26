import { useEffect, type ReactNode } from 'react';
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
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        className={clsx(
          'relative card max-h-[85vh] overflow-hidden flex flex-col max-w-[calc(100vw-2rem)]',
        )}
        style={{ width }}
      >
        {(title || !hideClose) && (
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <div className="text-base font-medium text-text dark:text-text-dark">{title}</div>
            {!hideClose && (
              <button
                type="button"
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
