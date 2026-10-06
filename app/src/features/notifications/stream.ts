/**
 * 通知模块 SSE 客户端
 * ---------------------------------------------------------------
 * 两件事：
 *  - upsertById    纯函数：按 id in-place 替换；新 id unshift 到队首
 *  - openNotificationStream  副作用入口：原生 EventSource，5 次 onerror 后回调 onClose
 *
 * 不引第三方库：浏览器原生 EventSource 已实现 RFC 5.1 自动重连（默认 3s 起步），
 * 我们只需要在"持续失败"时切回 30s 轮询兜底。
 * ponytail: 没有自写退避序列——原生重连间隔浏览器说了算，"切轮询"只用次数判定足够。
 */
import { toNotification, type AppNotification } from './types';

/** 已有 id → in-place 替换；新 id → unshift 到队首；保持其它顺序不变 */
export function upsertById(list: AppNotification[], n: AppNotification): AppNotification[] {
  const idx = list.findIndex((x) => x.id === n.id);
  if (idx < 0) return [n, ...list];
  const next = list.slice();
  next[idx] = n;
  return next;
}

/** 连续 N 次 onerror 后关闭 EventSource 并回调 onClose，让上层切回 30s 轮询 */
const MAX_ERROR_ATTEMPTS = 5;

export interface StreamHandlers {
  onCreated: (n: AppNotification) => void;
  onResolved: (id: number) => void;
  onDismissed: (id: number) => void;
  onExpired: (id: number) => void;
  /** EventSource 已关闭、上层应切回轮询 */
  onClose: () => void;
}

/**
 * 打开 SSE 流并接入回调。
 * cleanupFns 是调用方传入的清理容器，我们把 es.close() 推进去，组件 unmount 时统一调。
 * 不传则内部不持有——React 组件通常必传，否则 EventSource 会泄漏。
 */
export function openNotificationStream(
  handlers: StreamHandlers,
  cleanupFns: Array<() => void>,
): void {
  const es = new EventSource('/api/notifications/stream');
  cleanupFns.push(() => es.close());

  let attempts = 0;
  const resetAttempts = (): void => {
    attempts = 0;
  };

  es.addEventListener('notification', (ev) => {
    const raw = JSON.parse((ev as MessageEvent<string>).data) as {
      kind: string;
      notification: Parameters<typeof toNotification>[0];
    };
    const n = toNotification(raw.notification);
    if (n) handlers.onCreated(n);
    resetAttempts();
  });

  const handleIdOnly = (key: 'resolved' | 'dismissed' | 'expired') => (ev: Event) => {
    const raw = JSON.parse((ev as MessageEvent<string>).data) as { id: unknown };
    if (typeof raw.id !== 'number' || !Number.isFinite(raw.id)) return;
    const cb: (id: number) => void =
      key === 'resolved' ? handlers.onResolved : key === 'dismissed' ? handlers.onDismissed : handlers.onExpired;
    cb(raw.id);
    resetAttempts();
  };
  es.addEventListener('resolved', handleIdOnly('resolved'));
  es.addEventListener('dismissed', handleIdOnly('dismissed'));
  es.addEventListener('expired', handleIdOnly('expired'));

  es.onerror = (): void => {
    // EventSource 自带重连（默认 ~3s）；只有持续失败才升级为"切轮询"。
    attempts += 1;
    if (attempts >= MAX_ERROR_ATTEMPTS) {
      es.close();
      handlers.onClose();
    }
  };
}