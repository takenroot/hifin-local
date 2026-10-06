/**
 * NotificationBell — 工具排的通知铃铛（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 复用 notifications/api 的 fetchPendingNotifications + resolveNotification +
 * dismissNotification（见 NotificationCenter 同源 import）。
 *
 * 与 NotificationCenter 的关系（重要）：
 *   - NotificationCenter 挂在 AppLayout 顶层，负责 need_password 弹窗 + 30s 轮询。
 *   - 本组件再拉一份 pending（30s 轮询），给侧栏铃铛一个独立视图。
 *   ponytail: 与 NotificationCenter 各一份轮询是 known ceiling——本地单用户
 *   同一进程内可接受；改成共享 SWR 时再合并。
 *     升级路径：把 pending 列表提升到一个 useApi + 30s setInterval 的 hook，
 *     NotificationCenter 与本组件共同订阅；现在两路轮询各走各的 fetch，
 *     失败回退语义也都是"静默吞掉"，合并只是性能优化。
 *
 * popover 打开时拉一次 + 30s 后台轮询；每条通知有「解决/忽略」按钮。
 * aria-live=polite 让 resolve/dismiss 后残条消失对读屏温和。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconBell, IconCheck, IconBellOff } from '@tabler/icons-react';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import relativeTime from 'dayjs/plugin/relativeTime';
import {
  dismissNotification,
  fetchPendingNotifications,
  resolveNotification,
} from '@/features/notifications/api';
import type { AppNotification } from '@/features/notifications/types';
import { POLL_INTERVAL_MS } from '@/features/notifications/logic';

dayjs.extend(relativeTime);
dayjs.locale('zh-cn');

const POLL_INTERVAL_LABEL = `${POLL_INTERVAL_MS / 1000}s`;

interface NotificationBellProps {
  collapsed?: boolean;
}

export function NotificationBell({ collapsed = false }: NotificationBellProps) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<AppNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number; placement: 'right' | 'left' } | null>(
    null,
  );
  const mountedRef = useRef(true);

  // popover 位置
  useEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const POPOVER_W = 360;
    const POPOVER_H = 320; // 标题 + 列表 + 内边距；溢出视口时上翻
    const wantRight = collapsed || r.right + POPOVER_W + 8 <= window.innerWidth;
    const wantBelow = collapsed || r.bottom + POPOVER_H + 8 <= window.innerHeight;
    const placement: 'right' | 'left' = wantRight ? 'right' : 'left';
    setPos({
      left: placement === 'right' ? r.right + 8 : r.right - POPOVER_W - 8,
      top: wantBelow ? r.bottom + 4 : r.top - POPOVER_H - 4,
      placement,
    });
  }, [open, collapsed]);

  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open]);

  // 外部点击关闭
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

  // 打开时拉一次；popover 期间 30s 后台轮询（与 NotificationCenter 同周期）
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const fresh = await fetchPendingNotifications();
    if (!mountedRef.current) return;
    setList(fresh);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!open) return;
    void reload();
    const timer = window.setInterval(() => {
      void reload();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [open, reload]);

  const pendingCount = list.length;

  async function handleResolve(n: AppNotification) {
    // 乐观移除：UI 立刻反映，用户感觉是即时的
    setList((prev) => prev.filter((x) => x.id !== n.id));
    await resolveNotification(n.id);
    // 失败的下次轮询会带回来——不阻塞 UI
  }

  async function handleDismiss(n: AppNotification) {
    setList((prev) => prev.filter((x) => x.id !== n.id));
    await dismissNotification(n.id);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={
          collapsed
            ? `通知${pendingCount > 0 ? `（${pendingCount} 条未读）` : ''}`
            : undefined
        }
        aria-label={
          pendingCount > 0 ? `通知：${pendingCount} 条未读` : '通知：无未读'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        className="relative flex items-center justify-center w-9 h-9 rounded-xl text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-dark transition"
      >
        <IconBell size={18} />
        {pendingCount > 0 && (
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-danger dark:bg-danger-dark text-white text-[10px] leading-4 text-center font-medium"
          >
            {pendingCount > 99 ? '99+' : pendingCount}
          </span>
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="通知"
          className={clsx(
            'fixed z-50 card !rounded-xl !p-1 w-[360px] max-w-[calc(100vw-1rem)]',
            pos.placement === 'right' ? '-translate-x-0' : '-translate-x-full',
          )}
          style={{ left: pos.left, top: pos.top }}
        >
          <div className="px-3 pt-2.5 pb-2 flex items-center justify-between">
            <div className="text-sm font-medium text-text dark:text-text-dark">通知</div>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">
              每 {POLL_INTERVAL_LABEL} 自动刷新
            </div>
          </div>

          {/* 列表区：aria-live=polite 让条目变化温和播报，resolve/dismiss 后残条消失也走同通道 */}
          <div aria-live="polite" className="max-h-[60vh] overflow-auto">
            {!loaded ? (
              <div className="px-3 py-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                加载中…
              </div>
            ) : list.length === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-text-muted dark:text-text-muted-dark">
                暂无待处理通知
              </div>
            ) : (
              <ul className="divide-y divide-border dark:divide-border-dark">
                {list.map((n) => (
                  <li key={n.id} className="px-3 py-2.5">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-text dark:text-text-dark truncate">
                          {n.title || '通知'}
                        </div>
                        {n.message && (
                          <div className="mt-0.5 text-xs leading-relaxed text-text-muted dark:text-text-muted-dark line-clamp-3 break-words">
                            {n.message}
                          </div>
                        )}
                        <div className="mt-1 text-[11px] text-text-muted dark:text-text-muted-dark/80">
                          {dayjs(n.createdAt).fromNow()}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center gap-1.5 justify-end">
                      <button
                        type="button"
                        onClick={() => void handleDismiss(n)}
                        className="h-7 px-2.5 rounded-lg text-xs text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-dark transition flex items-center gap-1"
                      >
                        <IconBellOff size={12} />
                        忽略
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleResolve(n)}
                        className="h-7 px-2.5 rounded-lg text-xs font-medium bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark hover:opacity-90 transition flex items-center gap-1"
                      >
                        <IconCheck size={12} />
                        解决
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
