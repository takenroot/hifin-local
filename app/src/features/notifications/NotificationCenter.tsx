/**
 * 全局通知中心
 * ---------------------------------------------------------------
 * 挂在 AppLayout 顶层，负责三件事：
 *
 *  1. 每 30 秒轮询 GET /api/notifications?status=pending
 *  2. need_password / password_error 通知 → 弹 Modal 索要解压密码
 *  3. import_success / import_failed 通知 → 右上角 toast 播报后自动 resolve
 *
 * 密码提交流程：
 *   输入密码 → POST /api/bills/:uid/password → "正在解压导入…"
 *   → 30 秒后强制再拉一次（给后端解压导入的时间）
 *   → 通知从 pending 列表消失（被 resolve）⇒ 判定成功，弹绿色 toast
 *
 * 设计取舍：
 *  - 判定逻辑（还剩几次 / 文案 / 提交结果）都在 logic.ts 纯函数里，
 *    这里只做状态编排 + 渲染。
 *  - 轮询失败静默吞掉：通知是"锦上添花"，不该在网络抖动时反复弹错。
 *  - 处理期间暂停周期轮询，只留 +30s 那一次，避免在导入真正完成前
 *    就把 need_password 判成"已消失"从而误报成功。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconAlertCircle,
  IconBrandAlipay,
  IconBrandWechat,
  IconCircleCheck,
  IconLoader2,
  IconWallet,
  IconX,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Button, Input, Modal } from '@/components/ui';
import {
  dismissNotification,
  fetchPendingNotifications,
  resolveNotification,
  submitBillPassword,
} from './api';
import {
  DEFAULT_MODAL_TITLE,
  EXHAUSTED_MESSAGE,
  MAX_IMPORT_WAIT_ROUNDS,
  MAX_PASSWORD_RETRY,
  POLL_INTERVAL_MS,
  PROCESSING_WAIT_MS,
  TOAST_TTL_MS,
  aiInsightToastMessage,
  importFailedMessage,
  importSuccessMessage,
  isExhausted,
  passwordErrorMessage,
  pickModalNotification,
  pickToastNotifications,
  platformLabel,
  remainingAttempts,
} from './logic';
import type { AppNotification } from './types';
import { openNotificationStream, upsertById } from './stream';

interface Toast {
  key: number;
  tone: 'success' | 'error';
  text: string;
  expiresAt: number;
}

let toastSeq = 0;

export function NotificationCenter() {
  const [notifications, setNotifications] = useState<AppNotification[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);

  /** 已播报过的 toast 通知，防止每 30 秒轮询都把同一条结果再播一次 */
  const seenToastIds = useRef<Set<number>>(new Set());
  /** 本会话已忽略的通知；id 是 AUTOINCREMENT，不会被复用，可安全记住 */
  const dismissedIds = useRef<Set<number>>(new Set());
  const mounted = useRef(true);
  /** 正在等待后端导入的通知 id；null 表示没有在等待 */
  const processingId = useRef<number | null>(null);
  const waitTimer = useRef<number | null>(null);
  /** 已等待的 30 秒轮次；超过上限就收手，避免通知状态异常时永远卡在 loading */
  const waitRounds = useRef(0);
  /** 弹窗当前已知的 retry_count；只用于判断"又失败了一次" */
  const knownRetry = useRef(0);
  /** SSE 接入与轮询降级使用的清理容器；useEffect unmount 时统一倒序执行 */
  const cleanupFns = useRef<Array<() => void>>([]);

  /** 当前弹窗展示的通知（供异步回调读取，避免闭包拿到旧值） */
  const active = useMemo(
    () => notifications.find((n) => n.id === activeId) ?? null,
    [notifications, activeId],
  );
  const activeRef = useRef<AppNotification | null>(null);
  activeRef.current = active;

  const pushToast = useCallback((tone: Toast['tone'], text: string) => {
    toastSeq += 1;
    const toast: Toast = { key: toastSeq, tone, text, expiresAt: Date.now() + TOAST_TTL_MS };
    setToasts((prev) => [...prev, toast]);
  }, []);

  /* ─────────── 轮询 ─────────── */

  /** 拉一轮 pending 通知，返回这一轮拿到的列表（供等待逻辑直接判定） */
  const poll = useCallback(async (): Promise<AppNotification[]> => {
    const raw = await fetchPendingNotifications();
    // 已忽略的即使服务端还没生效，本会话内也不再弹
    const list = raw.filter((n) => !dismissedIds.current.has(n.id));
    if (!mounted.current) return [];
    setNotifications(list);
    setLoaded(true);
    return list;
  }, []);

  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    mounted.current = true;
    // 首屏仍走一次 REST，保证首帧有数据（SWR-style）
    void pollRef.current();
    if (typeof EventSource === 'undefined') {
      // 浏览器不支持 EventSource：保留 30s 轮询降级路径
      const timer = window.setInterval(() => {
        // 处理期间只等 +30s 那一次触发，处理完自动回到常规节奏
        if (processingId.current != null) return;
        void pollRef.current();
      }, POLL_INTERVAL_MS);
      // 用一个 sentinel 放进 cleanupFns 让 unmount 时一并清掉
      cleanupFns.current.push(() => window.clearInterval(timer));
    } else {
      // EventSource 持续失败（5 次）→ 启动与原逻辑相同的 30s setInterval 轮询兜底
      openNotificationStream(
        {
          onCreated: (n) => setNotifications((prev) => upsertById(prev, n)),
          onResolved: (id) => setNotifications((prev) => prev.filter((x) => x.id !== id)),
          onDismissed: (id) => setNotifications((prev) => prev.filter((x) => x.id !== id)),
          onExpired: (id) => setNotifications((prev) => prev.filter((x) => x.id !== id)),
          onClose: () => {
            const timer = window.setInterval(() => {
              if (processingId.current != null) return;
              void pollRef.current();
            }, POLL_INTERVAL_MS);
            cleanupFns.current.push(() => window.clearInterval(timer));
          },
        },
        cleanupFns.current,
      );
    }
    return () => {
      mounted.current = false;
      while (cleanupFns.current.length > 0) {
        try {
          cleanupFns.current.pop()?.();
        } catch {
          /* noop */
        }
      }
      if (waitTimer.current != null) window.clearTimeout(waitTimer.current);
    };
  }, []);

  /* ─────────── 提交后等待导入 ─────────── */

  const scheduleImportCheck = useCallback(() => {
    if (waitTimer.current != null) window.clearTimeout(waitTimer.current);
    waitTimer.current = window.setTimeout(async () => {
      waitTimer.current = null;
      const waitingFor = processingId.current;
      if (waitingFor == null) return;

      const list = await pollRef.current();
      if (!mounted.current) return;
      // 通知已从 pending 消失 ⇒ 后端 resolve 了，由下面的 effect 收尾
      if (!list.some((n) => n.id === waitingFor)) return;

      waitRounds.current += 1;
      if (waitRounds.current >= MAX_IMPORT_WAIT_ROUNDS) {
        // 超过等待上限仍未收到结果：收手恢复轮询，让用户自行重试
        processingId.current = null;
        setProcessing(false);
        setActiveId(null);
        pushToast('error', '账单处理超时，请稍后在导入页重试');
        return;
      }
      scheduleImportCheck();
    }, PROCESSING_WAIT_MS);
  }, [pushToast]);

  /* ─────────── toast 播报 ─────────── */

  useEffect(() => {
    const fresh = pickToastNotifications(notifications, seenToastIds.current);
    if (fresh.length === 0) return;
    fresh.forEach((n) => seenToastIds.current.add(n.id));
    setToasts((prev) => [
      ...prev,
      ...fresh.map((n) => {
        // ai-insight 与 import_success 都按 success 播；只剩 import_failed 走 error
        const tone: Toast['tone'] = n.type === 'import_failed' ? 'error' : 'success';
        const text =
          n.type === 'import_success'
            ? importSuccessMessage(n)
            : n.type === 'ai-insight'
              ? aiInsightToastMessage(n.payload)
              : importFailedMessage(n);
        return {
          key: (toastSeq += 1),
          tone,
          text,
          expiresAt: Date.now() + TOAST_TTL_MS,
        };
      }),
    ]);
    // 结果已经播报过，让 core 把它收掉，别一直占着 pending
    fresh.forEach((n) => void resolveNotification(n.id));
  }, [notifications]);

  // 到期自动消失
  useEffect(() => {
    const timer = window.setInterval(() => {
      setToasts((prev) => (prev.length > 0 ? prev.filter((t) => t.expiresAt <= Date.now()) : prev));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  /* ─────────── 弹窗开合 ─────────── */

  // 没有正在展示的，就从待处理列表里挑一条该弹的
  useEffect(() => {
    if (activeId != null) return;
    const next = pickModalNotification(notifications);
    if (next) setActiveId(next.id);
  }, [notifications, activeId]);

  // 正在展示的那条从 pending 消失（被 resolve / 后端自行处理完）⇒ 收尾
  useEffect(() => {
    if (!loaded || activeId == null) return;
    if (notifications.some((n) => n.id === activeId)) return;
    setActiveId(null);
    setPassword('');
    setLocalError(null);
    if (processingId.current != null) {
      // 提交过密码且通知已消失 ⇒ 后端 resolve 了，判定导入成功
      processingId.current = null;
      setProcessing(false);
      pushToast('success', '导入成功，交易已更新');
    }
  }, [loaded, notifications, activeId, pushToast]);

  /* ─────────── 密码失败提示 ─────────── */

  // 切到另一条通知时重置基线
  useEffect(() => {
    knownRetry.current = active?.retryCount ?? 0;
  }, [activeId]);

  /**
   * "密码错误，还剩 N 次机会"的主要来源是**轮询**，不是提交响应。
   *
   * core 的 POST /api/bills/:uid/password 只做校验 + 把密码丢进内存 Map，
   * 一律返回 {ok:true}——密码对错是 poller 下一轮异步解压才知道的，它会把
   * retry_count +1 后由下一次 GET /api/notifications 带回来。
   * 所以这里盯住"弹窗开着时 retry_count 变大了"这一信号来报错。
   */
  useEffect(() => {
    if (!active || submitting || processing) return;
    if (active.retryCount <= knownRetry.current) {
      knownRetry.current = active.retryCount;
      return;
    }
    knownRetry.current = active.retryCount;
    const left = remainingAttempts(active);
    setLocalError(left > 0 ? passwordErrorMessage(left) : EXHAUSTED_MESSAGE);
  }, [active, submitting, processing]);

  /* ─────────── 交互 ─────────── */

  /** 关闭弹窗：点 X / 点遮罩 / "忽略"，都走 dismiss */
  const handleDismiss = useCallback(() => {
    const target = activeRef.current;
    if (!target) return;
    if (processingId.current != null && waitTimer.current != null) {
      window.clearTimeout(waitTimer.current);
      waitTimer.current = null;
    }
    processingId.current = null;
    setProcessing(false);
    // ⚠️ 必须同时把它从本地列表摘掉：否则下面"挑下一条弹窗"的 effect 会在
    // activeId 清空的同一次渲染里立刻把同一条又选回来，弹窗关不掉。
    dismissedIds.current.add(target.id);
    setNotifications((prev) => prev.filter((n) => n.id !== target.id));
    setActiveId(null);
    setPassword('');
    setLocalError(null);
    void dismissNotification(target.id);
  }, []);

  const handleSubmit = useCallback(
    async (e?: { preventDefault: () => void }) => {
      e?.preventDefault();
      const target = activeRef.current;
      if (!target) return;
      if (target.billUid == null) {
        setLocalError('该通知缺少账单信息，无法提交密码');
        return;
      }
      const pwd = password.trim();
      if (!pwd) {
        setLocalError('请输入解压密码');
        return;
      }

      setSubmitting(true);
      setLocalError(null);
      const out = await submitBillPassword(target.billUid, pwd);
      if (!mounted.current) return;
      setSubmitting(false);

      if (out.kind === 'accepted') {
        setPassword('');
        setProcessing(true);
        processingId.current = target.id;
        waitRounds.current = 0;
        // 这条"索要密码"已经兑现，直接 resolve，弹窗不会再顶回来
        void resolveNotification(target.id);
        // 给后端 30 秒解压导入，之后主动拉一次结果
        scheduleImportCheck();
        return;
      }

      if (out.kind === 'wrong_password') {
        // 后端若直接给了剩余次数就采用，否则按"这次失败已用掉一次"本地推算
        const left =
          out.remaining ?? Math.max(0, MAX_PASSWORD_RETRY - (target.retryCount + 1));
        const used = MAX_PASSWORD_RETRY - left;
        // 先乐观推进 retryCount，下一轮轮询再用服务端的真实值覆盖
        knownRetry.current = used;
        setNotifications((prev) =>
          prev.map((n) => (n.id === target.id ? { ...n, retryCount: used } : n)),
        );
        setPassword('');
        setLocalError(left > 0 ? passwordErrorMessage(left) : EXHAUSTED_MESSAGE);
        return;
      }

      // 其它失败（网络 / 5xx）不扣机会，只提示原因让用户重试
      setLocalError(out.detail ? `提交失败：${out.detail}` : '提交失败，请稍后重试');
    },
    [password, scheduleImportCheck],
  );

  /* ─────────── 渲染 ─────────── */

  const exhausted = active ? isExhausted(active) : false;
  const left = active ? remainingAttempts(active) : MAX_PASSWORD_RETRY;
  const canSubmit = !!active && active.billUid != null && !exhausted && !processing && !submitting;

  return (
    <>
      {active && (
        <Modal
          open
          onClose={processing ? () => {} : handleDismiss}
          // 处理中不给关，避免用户以为取消了导入其实后端还在跑
          hideClose={processing}
          title={processing ? '正在解压导入…' : active.title || DEFAULT_MODAL_TITLE}
          width={420}
          footer={
            processing ? undefined : (
              <>
                <Button variant="ghost" onClick={handleDismiss} disabled={submitting}>
                  忽略
                </Button>
                {!exhausted && (
                  <Button onClick={() => void handleSubmit()} disabled={!canSubmit}>
                    {submitting && <IconLoader2 size={16} className="animate-spin" />}
                    提交密码
                  </Button>
                )}
              </>
            )
          }
        >
          {processing ? (
            <ProcessingBody platform={active.platform} message={active.message} />
          ) : (
            <>
              <div className="flex items-center gap-3.5">
                <PlatformBadge platform={active.platform} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-text dark:text-text-dark">
                    {platformLabel(active.platform)}账单
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-text-muted dark:text-text-muted-dark">
                    {active.message ||
                      `已从邮箱下载到一封「${platformLabel(active.platform)}」账单，解压需要账单密码，导入后即可自动更新交易。`}
                  </p>
                </div>
              </div>

              {exhausted ? (
                <p
                  className="mt-4 rounded-xl bg-bg dark:bg-bg-card-dark px-3 py-2.5 text-xs leading-relaxed text-text-muted dark:text-text-muted-dark"
                  role="status"
                >
                  {EXHAUSTED_MESSAGE}
                </p>
              ) : (
                <form className="mt-4" onSubmit={(e) => void handleSubmit(e)}>
                  <label
                    htmlFor="notification-bill-password"
                    className="mb-1.5 block text-xs text-text-muted dark:text-text-muted-dark"
                  >
                    解压密码
                  </label>
                  <Input
                    id="notification-bill-password"
                    type="password"
                    autoFocus
                    value={password}
                    disabled={submitting}
                    placeholder="请输入账单解压密码"
                    invalid={!!localError && localError !== EXHAUSTED_MESSAGE}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      if (localError) setLocalError(null);
                    }}
                  />
                  <p className="mt-1.5 text-xs text-text-muted dark:text-text-muted-dark">还可尝试 {left} 次</p>
                </form>
              )}

              {localError && !exhausted && (
                <p
                  className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-danger dark:text-danger-dark"
                  role="alert"
                >
                  <IconAlertCircle size={14} className="mt-0.5 flex-none" />
                  <span>{localError}</span>
                </p>
              )}
            </>
          )}
        </Modal>
      )}

      <ToastStack toasts={toasts} onClose={(key) => setToasts((p) => p.filter((t) => t.key !== key))} />
    </>
  );
}

/* ─────────────────── 子组件 ─────────────────── */

/** 平台图标：支付宝 / 微信 / 未知平台兜底 */
function PlatformBadge({ platform }: { platform: string }) {
  const id = (platform || '').trim().toLowerCase();
  if (id === 'alipay') {
    return (
      <div className="w-14 h-14 rounded-2xl bg-brand-soft flex-none flex items-center justify-center">
        <IconBrandAlipay size={30} className="text-[#1677ff]" />
      </div>
    );
  }
  if (id === 'wechat' || id === 'weixin' || id === 'wechatpay') {
    return (
      <div className="w-14 h-14 rounded-2xl bg-income-soft dark:bg-income-soft-dark flex-none flex items-center justify-center">
        <IconBrandWechat size={30} className="text-[#07c160]" />
      </div>
    );
  }
  return (
    <div className="w-14 h-14 rounded-2xl bg-bg dark:bg-bg-card-dark flex-none flex items-center justify-center text-text-muted dark:text-text-muted-dark">
      <IconWallet size={28} />
    </div>
  );
}

/** 提交密码后的等待态 */
function ProcessingBody({ platform, message }: { platform: string; message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-2 text-center">
      <div className="w-14 h-14 rounded-2xl bg-brand-soft flex items-center justify-center">
        <IconLoader2 size={28} className="text-brand animate-spin" />
      </div>
      <div className="text-sm font-medium text-text dark:text-text-dark">正在解压导入…</div>
      <p className="text-xs leading-relaxed text-text-muted dark:text-text-muted-dark">
        正在解压「{platformLabel(platform)}」账单并导入交易，预计需要几十秒，请稍候…
      </p>
      {message && <p className="text-[11px] text-text-muted dark:text-text-muted-dark/80">{message}</p>}
    </div>
  );
}

/** 右上角 toast 栈；移动端改为底部通栏 */
function ToastStack({ toasts, onClose }: { toasts: Toast[]; onClose: (key: number) => void }) {
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed z-[60] flex flex-col gap-2
                 inset-x-3 bottom-3 sm:inset-x-auto sm:bottom-auto sm:top-4 sm:right-4 sm:w-[320px]"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.key}
          data-state="open"
          className="card !rounded-xl flex items-start gap-2.5 px-4 py-3 shadow-soft dark:shadow-soft-dark toast-card"
        >
          {/*
           * 2026-10-05 设计审查决策：toast 成功=success 绿 / 错误=danger 红。
           * 这条轴与金额语义正交——income 红 / expense 绿只表示"赚到钱/钱出去"，
           * 拿来表示"操作成功/失败"会让用户把系统反馈误读成金额变动，
           * 因此这里必须走 UI 状态令牌，不能借 income/expense。
           */}
          <span
            className={clsx(
              'mt-0.5 flex-none',
              t.tone === 'success' ? 'text-success' : 'text-danger dark:text-danger-dark',
            )}
          >
            {t.tone === 'success' ? <IconCircleCheck size={18} /> : <IconAlertCircle size={18} />}
          </span>
          <span
            className={clsx(
              'flex-1 text-sm leading-relaxed',
              t.tone === 'success'
                ? 'text-text dark:text-text-dark'
                : 'text-danger dark:text-danger-dark',
            )}
          >
            {t.text}
          </span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => onClose(t.key)}
            className="flex-none text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
          >
            <IconX size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
