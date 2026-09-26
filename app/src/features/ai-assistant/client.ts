/**
 * AI 助手 → OpenAI 兼容端点客户端
 *
 * 支持：POST {endpoint}/chat/completions
 * 非流式（stream: false）。
 *
 * 错误归类（友好提示）：
 *   - 网络错误（Failed to fetch / DNS / 离线）
 *   - CORS（浏览器拦截预检）
 *   - Key / 鉴权错误（HTTP 401/403）
 *   - 限流（HTTP 429）
 *   - 其它服务端错误（HTTP 5xx）
 *   - 响应解析错误（非 JSON）
 */
import type { AiModel } from '@/db';

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AiError {
  kind: 'network' | 'cors' | 'auth' | 'rate_limit' | 'server' | 'bad_response' | 'empty_endpoint' | 'unknown';
  message: string;
  status?: number;
}

export interface AiResult {
  text: string;
  latencyMs: number;
  /** 是否为 ping 测试（便于 UI 区分） */
  ping?: boolean;
}

const SYSTEM_PROMPT =
  '你是 HiFin 的个人财务助手，名字叫「小账」。回答简洁、用简体中文，可以参考下方用户的财务概况 JSON/文本进行个性化回答。当用户询问数据时优先使用这些数据；当用户要求修改数据时明确说明本地助手只能建议，请到对应页面操作。不要编造数据。';

/** ping 测试用：尽量小、便宜 */
const PING_MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a connectivity probe.' },
  { role: 'user', content: 'ping' },
];

/** 普通聊天：构造 system prompt + 历史 + 当前问题 */
export function buildChatMessages(
  systemExtra: string,
  history: ChatMessage[],
  userInput: string,
): ChatMessage[] {
  return [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\n以下是用户当前的财务概况：\n${systemExtra}` },
    ...history,
    { role: 'user', content: userInput },
  ];
}

interface OpenAiChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string };
    finish_reason?: string;
  }>;
  error?: { message?: string; type?: string; code?: string };
}

function readError(bodyText: string, status: number): string {
  try {
    const j = JSON.parse(bodyText) as OpenAiChatResponse;
    return j.error?.message ?? bodyText;
  } catch {
    return bodyText || `HTTP ${status}`;
  }
}

function classify(status: number, raw: string): AiError {
  if (status === 401 || status === 403) {
    return {
      kind: 'auth',
      message: 'API Key 无效或未授权。请检查模型配置中的 API Key 是否正确。',
      status,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate_limit',
      message: '请求过于频繁或已用尽额度，请稍后再试。',
      status,
    };
  }
  if (status >= 500) {
    return {
      kind: 'server',
      message: `服务异常（HTTP ${status}）：${raw.slice(0, 200)}`,
      status,
    };
  }
  if (status >= 400) {
    return {
      kind: 'server',
      message: `请求错误（HTTP ${status}）：${raw.slice(0, 200)}`,
      status,
    };
  }
  return { kind: 'unknown', message: raw || `HTTP ${status}`, status };
}

function describeError(e: unknown, status?: number): AiError {
  if (e instanceof TypeError) {
    const msg = e.message || '';
    // 浏览器跨域拦截 → fetch reject with TypeError
    if (/Failed to fetch|NetworkError|load failed/i.test(msg)) {
      return {
        kind: 'cors',
        message:
          '请求被浏览器拦截，可能是 CORS（跨域）问题。请确认 endpoint 配置了允许跨域（Access-Control-Allow-Origin），或使用本地代理。',
      };
    }
    return { kind: 'network', message: `网络错误：${msg}` };
  }
  if (status != null) {
    return classify(status, '');
  }
  return { kind: 'unknown', message: (e as Error)?.message ?? String(e) };
}

/** 构造完整 URL（用户可填完整地址或仅 path） */
function resolveUrl(endpoint: string): string {
  const trimmed = (endpoint || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** 通用单次请求 */
async function postChat(
  model: AiModel,
  messages: ChatMessage[],
  opts: { signal?: AbortSignal; temperature?: number; maxTokens?: number } = {},
): Promise<AiResult> {
  const url = resolveUrl(model.endpoint);
  if (!url) {
    throw {
      kind: 'empty_endpoint',
      message: '模型地址为空，请在设置中完善 endpoint。',
    } satisfies AiError;
  }

  const start = performance.now();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: model.model,
        messages,
        stream: false,
        temperature: opts.temperature ?? 0.5,
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    throw describeError(e);
  }

  const text = await res.text().catch(() => '');
  const latencyMs = Math.round(performance.now() - start);

  if (!res.ok) {
    const err = classify(res.status, readError(text, res.status));
    throw err;
  }

  let body: OpenAiChatResponse;
  try {
    body = JSON.parse(text) as OpenAiChatResponse;
  } catch {
    throw {
      kind: 'bad_response',
      message: '返回内容不是合法 JSON（请检查 endpoint 是否为 chat/completions 路径）。',
      status: res.status,
    } satisfies AiError;
  }

  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw {
      kind: 'bad_response',
      message: '模型返回内容为空。',
      status: res.status,
    } satisfies AiError;
  }

  return { text: content, latencyMs };
}

/** 普通聊天（构造 system prompt + 历史 + 当前问题） */
export async function chat(
  model: AiModel,
  snapshotText: string,
  history: ChatMessage[],
  userInput: string,
  opts: { signal?: AbortSignal } = {},
): Promise<AiResult> {
  const messages = buildChatMessages(snapshotText, history, userInput);
  return postChat(model, messages, { signal: opts.signal, temperature: 0.5 });
}

/** 轻量 ping（测试连接 / 显示延迟） */
export async function ping(model: AiModel, opts: { signal?: AbortSignal } = {}): Promise<AiResult> {
  const result = await postChat(model, PING_MESSAGES, {
    signal: opts.signal,
    temperature: 0,
    maxTokens: 8,
  });
  return { ...result, ping: true };
}

/** 把 AiError 转成 UI 展示用的中文提示 */
export function describeAiError(e: unknown): string {
  if (!e) return '未知错误';
  const err = e as AiError;
  if (err && typeof err === 'object' && 'kind' in err && 'message' in err) {
    return err.message;
  }
  return (e as Error)?.message ?? String(e);
}