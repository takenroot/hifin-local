/**
 * AI 洞察 → LLM 客户端
 *
 * 与 app/src/features/ai-assistant/client.ts 的契约**有意分离**：
 *  - ai-assistant 喂的是"用户问题 + 历史"，prompt 是自然语言对话；
 *  - 这里喂的是"结构化指标 + 规则版摘要"，prompt 是 JSON 拼接。
 * 复用 client 的错误归类（auth/network/rate_limit/server）与 resolveUrl 思路，
 * 因为这些是 OpenAI 兼容端点的共性；但调用入口独立，方便单测 + 后续切换模型。
 *
 * 关键约束（来自设计文档 §2.3）：
 *  - node 自带 fetch，30s AbortController 超时；
 *  - max_tokens=600、temperature=0.4；
 *  - 不重试：每月本来就只跑一次，重试交给下个月。
 */
import type { AiModelRow } from '../db/schema.js';
import type { MonthMetrics } from './metrics.js';

export type AiErrorKind =
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'server'
  | 'bad_response'
  | 'empty_endpoint'
  | 'timeout'
  | 'unknown';

export interface AiInsightError {
  kind: AiErrorKind;
  message: string;
  status?: number;
}

/** 系统 prompt：用简体中文写一段不超过 200 字的点评；只能引用 prompt 出现的数字 */
const SYSTEM_PROMPT = `你是 HiFin 的财务助手「小账」。基于下方结构化指标与规则版摘要，用简体中文写一段不超过 200 字的月度财务点评。要求：
- 不要编造数据，只能引用指标里出现的数字；
- 用平实语气，不要用 emoji 和过度修辞；
- 重点指出 1) 收支异常 2) 预算/目标风险 3) 一个改进建议；
- 若规则版摘要已足够清楚，原样返回。`;

/** Anthropic 协议识别：endpoint 路径含 /anthropic（与前端 client.ts 同一约定） */
export function isAnthropicEndpoint(endpoint: string): boolean {
  return /anthropic/i.test(endpoint ?? '');
}

/** Anthropic 响应形状（取 text 块） */
interface AnthropicChatResponse {
  content?: Array<{ type?: string; text?: string }>;
}

/**
 * 构造 Anthropic Messages payload：system 抽为顶级参数（Anthropic 禁止 system
 * 出现在 messages 数组）；max_tokens 地板 2048——MiniMax M3.1 强制 adaptive
 * thinking，thinking 会吃预算，剩余不够返回空 text（实测 2026-10-07）。
 */
export function buildAnthropicPayload(
  system: string,
  userContent: string,
  maxTokens?: number,
): { system: string; messages: Array<{ role: 'user'; content: string }>; max_tokens: number } {
  return {
    system,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: Math.max(maxTokens ?? 600, 2048),
  };
}

/** 从 Anthropic 响应体提取纯文本（无 text 块返回 null） */
export function parseAnthropicText(body: unknown): string | null {
  const b = body as AnthropicChatResponse;
  const text = b.content?.find((c) => c.type === 'text' && typeof c.text === 'string')?.text;
  return text ? text.trim() : null;
}

export interface InsightPromptInput {
  metrics: MonthMetrics;
  ruleNarrative: string;
}

export interface RenderOptions {
  /** 测试用：缩短超时；生产默认 30s */
  timeoutMs?: number;
  /** 测试用：调小上限；生产默认 600（设计文档硬约束） */
  maxTokens?: number;
}

function resolveUrl(endpoint: string): string {
  const trimmed = (endpoint || '').trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function classifyStatus(status: number, raw: string): AiInsightError {
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

function describeNetwork(e: unknown): AiInsightError {
  if (e instanceof Error && e.name === 'AbortError') {
    return { kind: 'timeout', message: 'LLM 调用超时（30s）' };
  }
  if (e instanceof TypeError) {
    return { kind: 'network', message: `网络错误：${e.message}` };
  }
  return { kind: 'unknown', message: (e as Error)?.message ?? String(e) };
}

interface OpenAiChatResponse {
  choices?: Array<{ message?: { role?: string; content?: string }; finish_reason?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

function pickErrorText(bodyText: string): string {
  try {
    const j = JSON.parse(bodyText) as OpenAiChatResponse;
    return j.error?.message ?? bodyText;
  } catch {
    return bodyText;
  }
}

/**
 * 调用 LLM 生成一段自然语言点评；失败抛 AiInsightRenderError（兼容任意错误形状）。
 *
 * ⚠️ 默认 30s 超时 / max_tokens=600 / temperature=0.4（设计文档硬约束）。
 * 失败由 caller 接住：log + 不抛、不删通知（两阶段提交的第一阶段已经写了一条规则版）。
 */
export async function llmRenderInsight(
  model: AiModelRow,
  input: InsightPromptInput,
  opts: RenderOptions = {},
): Promise<string> {
  const url = resolveUrl(model.endpoint ?? '');
  if (!url) {
    const err: AiInsightError = {
      kind: 'empty_endpoint',
      message: '模型地址为空，请在设置中完善 endpoint。',
    };
    throw err;
  }

  const anthropic = isAnthropicEndpoint(url);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const userContent =
    `规则版摘要：${input.ruleNarrative}\n\n` +
    `结构化指标(JSON):\n${JSON.stringify(input.metrics)}`;

  let requestUrl = url;
  let requestBody: unknown;
  if (anthropic) {
    // 同前端 client.ts：Bearer 走 CORS 白名单，x-api-key/anthropic-version 会被
    // MiniMax 的预检拒绝
    requestUrl = `${url.replace(/\/+$/, '')}/v1/messages`;
    if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;
    requestBody = {
      model: model.model,
      ...buildAnthropicPayload(SYSTEM_PROMPT, userContent, opts.maxTokens),
    };
  } else {
    if (model.apiKey) headers['Authorization'] = `Bearer ${model.apiKey}`;
    requestBody = {
      model: model.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      stream: false,
      temperature: 0.4,
      max_tokens: opts.maxTokens ?? 600,
    };
  }

  let res: Response;
  try {
    res = await fetch(requestUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw describeNetwork(e);
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw classifyStatus(res.status, pickErrorText(text));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const err: AiInsightError = {
      kind: 'bad_response',
      message: anthropic
        ? '返回内容不是合法 JSON（请检查 /anthropic 端点是否可达）。'
        : '返回内容不是合法 JSON（请检查 endpoint 是否为 chat/completions 路径）。',
      status: res.status,
    };
    throw err;
  }

  const content = anthropic
    ? parseAnthropicText(parsed)
    : (parsed as OpenAiChatResponse).choices?.[0]?.message?.content?.trim();
  if (!content) {
    const err: AiInsightError = {
      kind: 'bad_response',
      message: '模型返回内容为空。',
      status: res.status,
    };
    throw err;
  }
  return content;
}

/** 把 AiInsightError 转成中文提示；纯函数便于调用方直接展示 */
export function describeAiInsightError(e: unknown): string {
  if (!e) return 'unknown';
  if (typeof e === 'object' && 'kind' in e && 'message' in e) {
    return String((e as { message: unknown }).message);
  }
  return (e as Error)?.message ?? String(e);
}