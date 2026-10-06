/**
 * AccentPicker — 主题色调色盘（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 工具排里的调色盘按钮：点击 IconPalette 弹小 popover，5 个色点 + 名称，
 * 当前档色点外环高亮。aria:role=group + aria-labelledby，与 LabDataSwitch 同源约定
 * （field-convergence 测试已固化该模式）。
 *
 * ponytail: 颜色只在 CSS 层（index.css 的 --brand-rgb / [data-accent]），
 * 这里只 push 档位 key，不存任何色值——双维护一份色板是典型 smell。
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconPalette } from '@tabler/icons-react';
import { useAtom } from 'jotai';
import { accentAtom, type AccentKey } from '@/store/atoms';

/** 5 档调色盘：名称 + 色样（亮色档 hex，用于色点预览；暗色变体见 index.css） */
const SWATCHES: ReadonlyArray<{ key: AccentKey; name: string; hex: string }> = [
  { key: 'charcoal', name: '炭黑', hex: '#26262b' },
  { key: 'indigo', name: '靛蓝', hex: '#4f46e5' },
  { key: 'ocean', name: '海蓝', hex: '#0e7490' },
  { key: 'violet', name: '紫罗兰', hex: '#7c3aed' },
  { key: 'rose', name: '玫红', hex: '#e11d48' },
];

interface AccentPickerProps {
  /** 折叠态：只渲染图标 + title tooltip，居中 */
  collapsed?: boolean;
}

export function AccentPicker({ collapsed = false }: AccentPickerProps) {
  const [accent, setAccent] = useAtom(accentAtom);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // popover 弹出位置由 trigger 的 getBoundingClientRect 算，关闭时清掉
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'right' | 'left' } | null>(
    null,
  );

  // 打开时算位置：折叠态 popover 飞到 rail 右侧（与 SpaceSwitcher 同款），展开态向下贴 trigger
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const POPOVER_W = 240;
    const POPOVER_H = 5 * 36 + 16; // 5 档 + 内边距；保守值，溢出更安全
    // 折叠态往右飞出（rail 装不下 240px 宽度），否则向下；右沿超出 viewport 时翻向左侧
    const wantRight = collapsed || r.right + POPOVER_W + 8 <= window.innerWidth;
    // 展开态：trigger 在底部附近时向上翻，避免超出视口
    const wantBelow = collapsed || r.bottom + POPOVER_H + 8 <= window.innerHeight;
    const placement: 'right' | 'left' = wantRight ? 'right' : 'left';
    setPos({
      left: placement === 'right' ? r.right + 8 : r.right - POPOVER_W - 8,
      top: wantBelow ? r.bottom + 4 : r.top - POPOVER_H - 4,
      placement,
    });
  }, [open, collapsed]);

  // Esc 关闭（与 AppLayout 抽屉同款，无 portal 时挂在 trigger 上即可）
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 点 popover 外部关闭：mousedown 在 trigger / popover 之外都视为外部
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (!t) return;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const popoverRef = useRef<HTMLDivElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        title={collapsed ? `调色盘（当前：${nameOf(accent)}）` : undefined}
        aria-label="切换主题色调色盘"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={clsx(
          'flex items-center rounded-xl text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-dark transition',
          collapsed ? 'w-9 h-9 justify-center' : 'w-9 h-9 justify-center',
        )}
      >
        <IconPalette size={18} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="主题色调色盘"
          className={clsx(
            'fixed z-50 card !rounded-xl !p-1 w-[240px]',
            pos.placement === 'right' ? '-translate-x-0' : '-translate-x-full',
          )}
          style={{ left: pos.left, top: pos.top }}
          // popover 自管 mouseDown 关闭，这里只拦 wheel 不外溢
        >
          <span id="accent-picker-label" className="sr-only">
            主题色调色盘
          </span>
          <div role="group" aria-labelledby="accent-picker-label" className="flex flex-col">
            {SWATCHES.map((s) => {
              const active = accent === s.key;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => {
                    setAccent(s.key);
                    setOpen(false);
                  }}
                  aria-pressed={active}
                  className={clsx(
                    'flex items-center gap-2.5 w-full h-9 px-2.5 rounded-lg text-sm transition',
                    active
                      ? 'bg-bg dark:bg-bg-dark text-text dark:text-text-dark font-medium'
                      : 'text-text dark:text-text-dark hover:bg-bg dark:hover:bg-bg-dark',
                  )}
                >
                  <span
                    aria-hidden
                    className={clsx(
                      'w-5 h-5 rounded-full flex-none ring-2 ring-offset-2 ring-offset-bg-card dark:ring-offset-bg-card-dark',
                      active ? 'ring-brand' : 'ring-transparent',
                    )}
                    style={{ backgroundColor: s.hex }}
                  />
                  <span className="flex-1 text-left truncate">{s.name}</span>
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

function nameOf(key: AccentKey): string {
  return SWATCHES.find((s) => s.key === key)?.name ?? key;
}
