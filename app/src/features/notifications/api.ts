/**
 * 通知模块的 REST 适配层
 * ---------------------------------------------------------------
 * 只负责发请求 + 调 logic/types 里的纯函数，不含 UI。
 *
 * 与其它 feature 的 api.ts 保持一致：core 直接返回 SQLite 原始行，
 * 列表统一走 toNotificationList 归一化后才交给组件。
 */
import { apiFetch } from '@/hooks/useApi';
import { parsePasswordSubmit, type PasswordSubmitOutcome } from './logic';
import { toNotification, toNotificationList, type AppNotification, type RestNotification } from './types';

/** 拉取待处理通知。返回空数组表示"没有待办"，不抛错——轮询失败不该打扰用户。 */
export async function fetchPendingNotifications(signal?: AbortSignal): Promise<AppNotification[]> {
  try {
    const r = await fetch('/api/notifications?status=pending', signal ? { signal } : undefined);
    if (!r.ok) return [];
    return toNotificationList(await r.json());
  } catch {
    /* 网络抖动 / 组件卸载：静默跳过，下一轮轮询会重试 */
    return [];
  }
}

/**
 * 提交账单解压密码。
 *
 * 刻意不直接用 apiFetch：apiFetch 对非 2xx 抛异常，而这里必须拿到
 * **状态码 + 响应体** 才能区分"密码错了"和"服务出错"（见 parsePasswordSubmit）。
 */
export async function submitBillPassword(
  uid: number,
  password: string,
): Promise<PasswordSubmitOutcome> {
  let status = 0;
  let body: unknown = null;
  try {
    const r = await fetch(`/api/bills/${encodeURIComponent(String(uid))}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    status = r.status;
    // 成功时后端可能回 204 无体，text() 对空体返回 ''，解析失败按 null 处理
    const text = await r.text().catch(() => '');
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
  } catch (e) {
    return { kind: 'failed', detail: (e as Error).message };
  }
  return parsePasswordSubmit(status, body);
}

/** 通知已处理完（导入成功 / 后端自行 resolve），告知 core 不必再提示 */
export async function resolveNotification(id: number): Promise<void> {
  try {
    await apiFetch(`/api/notifications/${encodeURIComponent(String(id))}/resolve`, 'POST');
  } catch {
    /* 幂等操作：失败也无所谓，下一轮轮询会重新拉状态 */
  }
}

/** 用户点"忽略"：这条需求还在，但不再打扰 */
export async function dismissNotification(id: number): Promise<void> {
  try {
    await apiFetch(`/api/notifications/${encodeURIComponent(String(id))}/dismiss`, 'POST');
  } catch {
    /* 同上，忽略失败不阻断 UI */
  }
}

/** 拉取单条 AI 洞察详情（Modal 打开后异步刷新 llmNarrative） */
export async function fetchAiInsightDetail(id: number): Promise<AppNotification | null> {
  try {
    const r = await fetch(`/api/ai-insights/${encodeURIComponent(String(id))}`);
    if (!r.ok) return null;
    const data = (await r.json()) as RestNotification;
    return toNotification(data);
  } catch {
    /* 网络抖动：返回 null，让上层继续展示规则版 */
    return null;
  }
}
