/**
 * 通知模块的纯逻辑
 * ---------------------------------------------------------------
 * 把"还剩几次机会""这句文案怎么说""这条通知算弹窗还是算 toast""这次提交算成功
 * 还是算密码错"这些**决定**从 React 组件里抽出来——组件只负责渲染和事件，
 * 便于在无 DOM 的测试环境里直接覆盖这些分支。
 *
 * 本文件不 import React、不发 fetch。
 */
import type { AppNotification, NotificationType } from './types';

/** 密码最多尝试次数；与 core 端封包失败后的封禁阈值一致 */
export const MAX_PASSWORD_RETRY = 3;

/** 3 次都错之后的中性提示 */
export const EXHAUSTED_MESSAGE = '密码错误过多，请手动下载导入';

/** 弹窗中「检测到新账单」的兜底标题 */
export const DEFAULT_MODAL_TITLE = '检测到新账单';

/** 轮询周期：30 秒一次 */
export const POLL_INTERVAL_MS = 30_000;

/** 提交密码后给后端解压导入的等待窗口：30 秒 */
export const PROCESSING_WAIT_MS = 30_000;

/**
 * 最多连续等几轮 30 秒（3 轮 = 90 秒）。
 * 纯粹是防呆：万一后端没有把通知置为 resolved，UI 也不能永远卡在 loading。
 */
export const MAX_IMPORT_WAIT_ROUNDS = 3;

/** toast 自动消失时间 */
export const TOAST_TTL_MS = 5_000;

/** 平台 id → 中文名（core 的 platform 存 alipay / wechat） */
const PLATFORM_LABEL: Record<string, string> = {
  alipay: '支付宝',
  wechat: '微信支付',
  weixin: '微信支付',
  wechatpay: '微信支付',
  cmb: '招商银行',
  bank: '银行',
};

/** 平台 id → 中文名，未知平台回退成"账单" */
export function platformLabel(platform: string | undefined | null): string {
  const key = (platform ?? '').trim().toLowerCase();
  if (!key) return '账单';
  return PLATFORM_LABEL[key] ?? platform ?? '账单';
}

/** 还剩几次机会（已用 retryCount 次，最多 MAX_PASSWORD_RETRY 次） */
export function remainingAttempts(n: Pick<AppNotification, 'retryCount'>): number {
  if (!Number.isFinite(n.retryCount)) return MAX_PASSWORD_RETRY;
  return Math.max(0, MAX_PASSWORD_RETRY - Math.max(0, Math.trunc(n.retryCount)));
}

/** 3 次已用尽：只展示提示，不再接受密码输入 */
export function isExhausted(n: Pick<AppNotification, 'retryCount'>): boolean {
  return remainingAttempts(n) <= 0;
}

/** 红色错误文案："密码错误，还剩 N 次机会"（remaining 传的是**这次失败之后**的余额） */
export function passwordErrorMessage(remaining: number): string {
  const left = Math.max(0, Math.trunc(remaining));
  return left > 0
    ? `密码错误，还剩 ${left} 次机会`
    : EXHAUSTED_MESSAGE;
}

/**
 * 从通知文案里抠出导入笔数。
 * 后端目前没有单独的计数字段，笔数只出现在 message/title 文本中
 * （如"已导入 128 笔交易"），因此按"数字 + 笔"匹配，匹配不到再退回任意数字。
 */
export function importCountOf(n: Pick<AppNotification, 'message' | 'title'>): number | null {
  const text = `${n.title ?? ''} ${n.message ?? ''}`;
  const byUnit = text.match(/(\d+)\s*笔/);
  if (byUnit?.[1]) return Number.parseInt(byUnit[1], 10);
  const anyNumber = text.match(/(\d+)/);
  if (anyNumber?.[1]) return Number.parseInt(anyNumber[1], 10);
  return null;
}

/** 绿色 toast："已导入 N 笔交易"；文案里没有数字时退化为"账单导入成功" */
export function importSuccessMessage(n: Pick<AppNotification, 'message' | 'title'>): string {
  const count = importCountOf(n);
  return count == null ? '账单导入成功' : `已导入 ${count} 笔交易`;
}

/** 红色 toast：优先用后端给的失败原因，没有就用通用文案 */
export function importFailedMessage(n: Pick<AppNotification, 'message' | 'title'>): string {
  const detail = (n.message ?? '').trim() || (n.title ?? '').trim();
  return detail ? `账单导入失败：${detail}` : '账单导入失败';
}

/** 需要用户输入密码、必须用 Modal 的两类通知 */
export function needsPasswordModal(type: NotificationType): boolean {
  return type === 'need_password' || type === 'password_error';
}

/** 只用 toast 播报、不打断操作的两类通知 */
export function isToastType(type: NotificationType): boolean {
  return type === 'import_success' || type === 'import_failed' || type === 'ai-insight';
}

/**
 * 从待处理列表里挑出当前该弹窗的那条。
 * 优先级：需要密码的 > 后创建的（同类型时新邮件优先），
 * 避免两条 need_password 并存时用户先看到旧的那封。
 */
export function pickModalNotification(list: AppNotification[]): AppNotification | null {
  let best: AppNotification | null = null;
  for (const n of list) {
    if (!needsPasswordModal(n.type)) continue;
    if (!best || n.createdAt > best.createdAt || (n.createdAt === best.createdAt && n.id > best.id)) {
      best = n;
    }
  }
  return best;
}

/** 从待处理列表里挑出本次要播报的 toast（按创建时间升序，播报顺序稳定） */
export function pickToastNotifications(
  list: AppNotification[],
  seen: ReadonlySet<number>,
): AppNotification[] {
  return list
    .filter((n) => isToastType(n.type) && !seen.has(n.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id - b.id);
}

/** ai-insight 的 toast 文案：取 payload.summary 前 60 字；空则用通用文案 */
export function aiInsightToastMessage(payload: unknown): string {
  const summary = extractInsightSummary(payload);
  if (summary) return summary.length > 60 ? `${summary.slice(0, 60)}…` : summary;
  return '本月财务小结已生成，点击查看';
}

function extractInsightSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const obj = payload as Record<string, unknown>;
  return typeof obj.summary === 'string' ? obj.summary : '';
}

/* ─────────────────── 密码提交结果解析 ─────────────────── */

/**
 * 提交密码的三种结局：
 *  - accepted       后端收下了密码，开始解压导入
 *  - wrong_password 密码不对，扣一次机会
 *  - failed         其它失败（网络 / 5xx / 未知原因），不扣机会
 */
export type PasswordSubmitKind = 'accepted' | 'wrong_password' | 'failed';

export interface PasswordSubmitOutcome {
  kind: PasswordSubmitKind;
  /** 后端若直接返回了剩余次数就优先采用，否则由调用方用 retryCount 推算 */
  remaining?: number;
  /** 展示给用户的原因（仅失败时有意义） */
  detail?: string;
}

/** 后端错误串里出现这些词，判定为"密码错了"而不是"服务挂了" */
const PASSWORD_HINTS = ['password', '密码', 'unzip', 'decrypt', 'encrypted'];

/**
 * 参数校验类错误的特征词。
 *
 * ⚠️ 这条不能省：core 的 POST /api/bills/:uid/password 对"password 必填且必须
 * 是非空字符串"返回 400，而错误串里含 "password"。若不做排除，一次空提交的
 * 校验失败会被误判成"密码错误"，白白扣掉用户一次重试机会。
 */
const VALIDATION_HINTS = ['必填', '必须是', '参数', 'invalid', 'required', 'validation', 'expected'];

/** 宽松地把后端可能返回的几种错误表示统一成小写可比较的串 */
function errorText(body: unknown, status: number): string {
  if (typeof body === 'string') return body.toLowerCase();
  if (body && typeof body === 'object') {
    const obj = body as Record<string, unknown>;
    const parts = [obj.error, obj.code, obj.message, obj.reason, obj.detail];
    const joined = parts.filter((p) => typeof p === 'string').join(' ').toLowerCase();
    if (joined) return joined;
  }
  return `http ${status}`;
}

/** 从后端响应里尽力提取剩余次数（0/1 也可能以字符串出现） */
function extractRemaining(body: unknown): number | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  for (const key of ['remaining', 'remainingAttempts', 'retriesLeft', 'left']) {
    const v = obj[key];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number.parseInt(v.trim(), 10);
  }
  return undefined;
}

/**
 * 判定 POST /api/bills/:uid/password 的结果。
 *
 * 兼容并行的 core 实现可能给出的多种形状：裸 204、{ok:true}、{ok:false,error}、
 * {success:false}，以及非 2xx 状态码。判定顺序刻意保守：
 * **只有明确失败才报失败**，其余一律按"已受理"处理——宁可多等一次轮询，
 * 也不能把正确的密码判成失败让用户以为白输了。
 */
export function parsePasswordSubmit(status: number, body: unknown): PasswordSubmitOutcome {
  const remaining = extractRemaining(body);

  if (status >= 200 && status < 300) {
    const explicitFail =
      (!!body && typeof body === 'object'
        ? (body as Record<string, unknown>).ok === false ||
          (body as Record<string, unknown>).success === false
        : false);
    if (!explicitFail) return { kind: 'accepted', remaining };
    return toFailure(errorText(body, status), remaining);
  }

  return toFailure(errorText(body, status), remaining);
}

function toFailure(text: string, remaining: number | undefined): PasswordSubmitOutcome {
  // 校验类错误优先排除：它是"请求没写对"，不是"密码没猜对"
  if (VALIDATION_HINTS.some((h) => text.includes(h))) {
    return { kind: 'failed', remaining, detail: text };
  }
  if (PASSWORD_HINTS.some((h) => text.includes(h))) {
    return { kind: 'wrong_password', remaining, detail: '密码错误' };
  }
  return { kind: 'failed', remaining, detail: text };
}
