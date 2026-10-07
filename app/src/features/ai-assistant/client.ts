/**
 * AI 助手 → OpenAI 兼容端点客户端
 *
 * 双协议（2026-10-07）：
 *   - OpenAI 兼容：POST {endpoint}/chat/completions（endpoint 以 /v1 结尾）
 *   - Anthropic 协议：endpoint 路径含 /anthropic 时自动走 {endpoint}/v1/messages
 *     （x-api-key + anthropic-version；MiniMax 的 anthropic 端点即此形态）
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
    // OpenAI 与 Anthropic 的错误体同为 {error:{message}}，一个读取两边覆盖
    const j = JSON.parse(bodyText) as OpenAiChatResponse & { error?: { message?: string } };
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
      // 2026-10-07 修正：Failed to fetch 不止 CORS——常见根因是端点协议不配
      // （HiFin 拼 /chat/completions，OpenAI 兼容地址以 /v1 结尾；MiniMax 的
      // /anthropic 是 Anthropic 协议，该路径 404 也会被浏览器报成网络错误）。
      // 文案给排查路径而不是单一归因。
      return {
        kind: 'cors',
        message:
          '请求未能到达服务端（网络错误/被浏览器拦截）。排查：① 地址是否为 OpenAI 兼容端点（如 MiniMax 用 https://api.minimax.cn/v1，/anthropic 协议地址不通）；② 浏览器控制台 Network 面板看真实失败原因；③ 该端点是否允许浏览器跨域。',
      };
    }
    return { kind: 'network', message: `网络错误：${msg}` };
  }
  if (status != null) {
    return classify(status, '');
  }
  return { kind: 'unknown', message: (e as Error)?.message ?? String(e) };
}

/**
 * 协议识别（2026-10-07）：MiniMax 等厂商提供 Anthropic 协议端点
 * （路径含 /anthropic，消息 API 为 /v1/messages）。用户明确使用此协议，
 * 按 endpoint 路径自动分流——比加配置项省一次 schema 迁移。
 * ponytail 已知上限：其它厂商的 anthropic 兼容端点若 URL 不含 "anthropic"
 * 会走 OpenAI 分支；届时再引入显式 protocol 字段。
 */
export function isAnthropicEndpoint(endpoint: string): boolean {
  return /anthropic/i.test(endpoint ?? '');
}

/** Anthropic Messages API 的响应形状（只取 text 块） */
interface AnthropicChatResponse {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

/**
 * 从 OpenAI 风格 messages 构造 Anthropic payload：
 * Anthropic 禁止 system 出现在 messages 数组里——抽出第一条 system 作顶级
 * system 参数。max_tokens 是 Anthropic 必填项。
 */
export function buildAnthropicPayload(
  messages: ChatMessage[],
  maxTokens?: number,
): { system?: string; messages: Array<{ role: 'user' | 'assistant'; content: string }>; max_tokens: number } {
  const rest = [...messages];
  let system: string | undefined;
  if (rest.length > 0 && rest[0].role === 'system') {
    system = rest.shift()!.content;
  }
  return {
    ...(system !== undefined ? { system } : {}),
    messages: rest.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    // max_tokens 是上限不是计费——MiniMax M3.1 强制 adaptive thinking（实测禁止
    // disabled），thinking 会吃掉预算，剩余不够就返回空 text。地板 2048 保 thinking+回答。
    max_tokens: Math.max(maxTokens ?? 1024, 2048),
  };
}

/** 从 Anthropic 响应体提取纯文本（无 text 块返回 null） */
export function parseAnthropicText(body: unknown): string | null {
  const b = body as AnthropicChatResponse;
  const text = b.content?.find((c) => c.type === 'text' && typeof c.text === 'string')?.text;
  return text ? text.trim() : null;
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

  const anthropic = isAnthropicEndpoint(url);
  const start = performance.now();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  let requestBody: unknown;
  let requestUrl = url;
  if (anthropic) {
    // Anthropic 协议：/v1/messages + x-api-key + anthropic-version；
    // 不支持 temperature/stream（忽略），MiniMax 实测 Bearer/x-api-key 均可
    requestUrl = `${url.replace(/\/+$/, '')}/v1/messages`;
    if (model.apiKey) headers['x-api-key'] = model.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    requestBody = { model: model.model, ...buildAnthropicPayload(messages, opts.maxTokens) };
  } else {
    if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;
    requestBody = {
      model: model.model,
      messages,
      stream: false,
      temperature: opts.temperature ?? 0.5,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    };
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw {
      kind: 'bad_response',
      message: anthropic
        ? '返回内容不是合法 JSON（请检查 /anthropic 端点是否可达）。'
        : '返回内容不是合法 JSON（请检查 endpoint 是否为 chat/completions 路径）。',
      status: res.status,
    } satisfies AiError;
  }

  const content = anthropic ? parseAnthropicText(parsed) : (parsed as OpenAiChatResponse).choices?.[0]?.message?.content?.trim();
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