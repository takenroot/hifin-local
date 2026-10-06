/**
 * 命令面板视图组件（增强版）
 *
 * - ⌘K / Ctrl + K 切换 commandPaletteOpenAtom（外部触发）
 * - Esc 关闭（Modal 已内置）
 * - 居中靠上：自定义 backdrop + 上方 12vh 偏移
 * - 分组：快捷操作 / 打开目录 / 操作
 * - 关键词过滤 + ↑↓ + Enter
 * - 帮助项触发 HelpDialog
 *
 * 注意：本组件独立于 src/layout/CommandPalette.tsx 存在。
 * 集成阶段可决定：把 src/layout/AppLayout.tsx 中的引用切到本组件，
 * 或保留两份共存。本文件不修改核心代码。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue } from 'jotai';
import { useNavigate } from 'react-router-dom';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import {
  IconSearch,
  IconArrowRight,
  IconCommand,
  IconCornerDownLeft,
  IconChevronUp,
  IconChevronDown,
} from '@tabler/icons-react';
import {
  commandPaletteOpenAtom,
} from '@/store/atoms';
import { CMD_ITEMS, type CmdItem } from './items';
import { HelpDialog } from './HelpDialog';

interface CommandPaletteProps {
  /** 受控：打开状态 */
  open: boolean;
  /** 受控：关闭回调 */
  onClose: () => void;
  /** 注入导航（默认使用 useNavigate） */
  navigate?: (to: string) => void;
  /** 测试 / 兼容：mock 数据 */
  items?: CmdItem[];
}

const GROUP_ORDER = ['快捷操作', '打开目录', '操作'];

export function CommandPaletteView({
  open,
  onClose,
  navigate,
  items,
}: CommandPaletteProps) {
  const list = items ?? CMD_ITEMS;
  const routerNavigate = useNavigate();
  const navFn = navigate ?? ((to: string) => routerNavigate(to));

  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [helpOpen, setHelpOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 打开时清空状态 + 聚焦；关闭时归还焦点给触发元素
  const triggerRef = useRef<Element | null>(null);
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement;
      setQuery('');
      setActive(0);
      // 等待 portal 完成
      requestAnimationFrame(() => inputRef.current?.focus());
    } else {
      requestAnimationFrame(() => {
        (triggerRef.current as HTMLElement | null)?.focus?.();
        triggerRef.current = null;
      });
    }
  }, [open]);

  // Esc 关闭（自管理模态，无 Modal 组件）
  useEffect(() => {
    if (!open) return;
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [open, onClose]);

  // 全局单键快捷键：t/n/c/a/s 执行对应命令（输入框聚焦时豁免；面板打开时让位给面板）
  useEffect(() => {
    if (open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      )
        return;
      const item = list.find((it) => it.shortcut === e.key.toLowerCase());
      if (!item) return;
      e.preventDefault();
      if (item.to === '__help__') {
        setHelpOpen(true);
      } else {
        navFn(item.to);
        onClose();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [list, navFn, onClose]);

  // 过滤后的列表（按 group 排序）
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? list.filter(
          (it) =>
            it.label.toLowerCase().includes(q) ||
            it.group.toLowerCase().includes(q),
        )
      : list;
    // 按 group 顺序稳定排序
    return [...matched].sort((a, b) => {
      const ai = GROUP_ORDER.indexOf(a.group);
      const bi = GROUP_ORDER.indexOf(b.group);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }, [list, query]);

  // 过滤结果变化时重置 active
  useEffect(() => {
    setActive(0);
  }, [query]);

  // 全局 ⌘K / Ctrl+K 触发由 AppLayout 控制；这里仅响应 Esc（Modal 内置）。
  // 额外：捕获键盘 ↑↓ Enter（仅在 input 不在 IME 输入时）
  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (filtered.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((idx) => {
        const next = (idx + 1) % filtered.length;
        scrollActiveIntoView(next);
        return next;
      });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((idx) => {
        const next = (idx - 1 + filtered.length) % filtered.length;
        scrollActiveIntoView(next);
        return next;
      });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = filtered[active];
      if (it) execute(it);
    }
  }

  function scrollActiveIntoView(idx: number) {
    requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLButtonElement>(
        `[data-cmd-index="${idx}"]`,
      );
      el?.scrollIntoView({ block: 'nearest' });
    });
  }

  function execute(item: CmdItem) {
    if (item.to === '__help__') {
      setHelpOpen(true);
      return;
    }
    navFn(item.to);
    onClose();
  }

  if (!open) return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        className={clsx(
          'fixed left-1/2 -translate-x-1/2 top-[12vh] z-50',
          'w-[560px] max-w-[92vw]',
          'rounded-2xl overflow-hidden border border-border dark:border-border-dark',
          // bento-motion §1 玻璃面板（侧边栏/⌘K/通知共享）：无开/关动画
          // Kowalski：100+/日键盘动作，绝对不要动画。
          'glass shadow-soft dark:shadow-soft-dark',
        )}
      >
        {/* 输入栏 */}
        <div className="flex items-center gap-2 px-4 h-12 border-b border-border dark:border-border-dark">
          <IconSearch size={16} className="text-text-muted dark:text-text-muted-dark" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索或输入指令…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-text-muted dark:text-text-muted-dark"
          />
          <span className="flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
            <span className="inline-flex items-center gap-0.5 px-1.5 h-5 rounded-md bg-bg dark:bg-bg-card-dark border border-border dark:border-border-dark">
              <IconCommand size={10} />K
            </span>
          </span>
        </div>

        {/* 结果区 */}
        <div ref={listRef} className="max-h-[60vh] overflow-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-5 py-10 text-center text-sm text-text-muted dark:text-text-muted-dark">
              未找到结果
            </div>
          ) : (
            (() => {
              // 按 group 分组渲染，但保持 active index 的全局映射
              let globalIdx = 0;
              const sections = GROUP_ORDER.filter((g) =>
                filtered.some((it) => it.group === g),
              );
              return sections.map((g) => {
                const items = filtered.filter((it) => it.group === g);
                return (
                  <div key={g} className="pb-1">
                    <div className="px-4 py-1.5 text-xs text-text-muted dark:text-text-muted-dark">
                      {g}
                    </div>
                    {items.map((it) => {
                      const idx = globalIdx++;
                      const isActive = idx === active;
                      return (
                        <button
                          key={it.id}
                          type="button"
                          data-cmd-index={idx}
                          data-active={isActive ? 'true' : undefined}
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => execute(it)}
                          className={clsx(
                            'w-full flex items-center gap-3 px-4 h-10 text-left text-sm transition',
                            isActive
                              ? 'bg-bg dark:bg-bg-card-dark text-text dark:text-text-dark'
                              : 'text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                          )}
                        >
                          <span
                            className={clsx(
                              'flex-none',
                              isActive
                                ? 'text-text dark:text-text-dark'
                                : 'text-text-muted dark:text-text-muted-dark',
                            )}
                          >
                            {it.icon ?? <IconArrowRight size={14} />}
                          </span>
                          <span className="flex-1 truncate">{it.label}</span>
                          {it.shortcut && (
                            <span className="text-xs text-text-muted dark:text-text-muted-dark">
                              {it.shortcut.toUpperCase()}
                            </span>
                          )}
                          {isActive && (
                            <span className="text-text-muted dark:text-text-muted-dark">
                              <IconCornerDownLeft size={12} />
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              });
            })()
          )}
        </div>

        {/* 底部提示栏 */}
        <div className="flex items-center justify-between gap-2 px-4 h-9 border-t border-border dark:border-border-dark text-xs text-text-muted dark:text-text-muted-dark">
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1">
              <IconChevronUp size={10} />
              <IconChevronDown size={10} />
              选择
            </span>
            <span className="inline-flex items-center gap-1">
              <IconCornerDownLeft size={10} />
              执行
            </span>
          </span>
          <span>HiFin 命令面板</span>
        </div>
      </div>
      <HelpDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
    </>,
    document.body,
  );
}

/** 便捷 hook：自动绑定 commandPaletteOpenAtom */
export function useCommandPaletteController(): {
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
} {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  return {
    open,
    onOpen: () => setOpen(true),
    onClose: () => setOpen(false),
  };
}

/** 只读 hook：外部组件检测命令面板是否打开 */
export function useCommandPaletteOpen(): boolean {
  return useAtomValue(commandPaletteOpenAtom);
}