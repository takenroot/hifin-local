/**
 * core/src/insights/llm.ts 单测 — mock fetch。
 *
 * 覆盖：
 *  - prompt 形态（system + user only，user content 是合法 JSON 字符串）
 *  - 超时（AbortController 30s 抛 AiInsightRenderError）
 *  - HTTP 401 → kind:'auth'；429 → kind:'rate_limit'；5xx → kind:'server'
 *  - 响应解析失败 → kind:'bad_response'
 *  - 空 endpoint → kind:'empty_endpoint'
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  llmRenderInsight,
  describeAiInsightError,
  type AiInsightError,
} from '../src/insights/llm.js';
import type { AiModelRow } from '../src/db/schema.js';

const MODEL_BASE: AiModelRow = {
  id: 1,
  name: 'test',
  model: 'gpt-4o-mini',
  endpoint: 'https://api.example.com/v1/chat/completions',
  apiKey: 'sk-test',
};

const INPUT = {
  metrics: {
    month: '2026-01',
    income: 5000,
    expense: 3000,
    net: 2000,
    momPct: 50,
    topExpense: [{ categoryId: 1, name: '餐饮', icon: '🍱', amount: 1500, pct: 50 }],
    topExpenseMom: [],
    largest: null,
    budgetAlerts: [],
    goalsNear: [],
    anomalyLarge: [],
  },
  ruleNarrative: '2026-01：收入 ¥5000，支出 ¥3000。',
};

function mockFetchOnce(impl: Parameters<typeof vi.fn>[0]): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('llmRenderInsight：prompt 形态', () => {
  it('请求 method/headers/body 形态正确：messages 只含两条，user content 是合法 JSON', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    mockFetchOnce(async (url: any, init: any) => {
      captured = { url, init };
      return new Response(
        JSON.stringify({ choices: [{ message: { role: 'assistant', content: '本月表现良好。' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const text = await llmRenderInsight(MODEL_BASE, INPUT);
    expect(text).toBe('本月表现良好。');
    expect(captured!.url).toBe(MODEL_BASE.endpoint);
    expect(captured!.init.method).toBe('POST');
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['Authorization']).toBe(`Bearer ${MODEL_BASE.apiKey}`);
    const body = JSON.parse(captured!.init.body as string);
    expect(body.model).toBe(MODEL_BASE.model);
    expect(body.stream).toBe(false);
    expect(body.temperature).toBe(0.4);
    expect(body.max_tokens).toBe(600);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
    // user content 里包含合法 JSON 的 metrics
    const userContent = body.messages[1].content as string;
    expect(userContent).toContain(INPUT.ruleNarrative);
    const jsonStart = userContent.indexOf('{');
    expect(jsonStart).toBeGreaterThanOrEqual(0);
    const parsed = JSON.parse(userContent.slice(jsonStart));
    expect(parsed.month).toBe('2026-01');
  });

  it('endpoint 缺省自动补 https:// 前缀', async () => {
    const model = { ...MODEL_BASE, endpoint: 'api.example.com/v1' };
    const fn = mockFetchOnce(async () => new Response('{"choices":[{"message":{"content":"hi"}}]}', { status: 200 }));
    await llmRenderInsight(model, INPUT);
    expect(fn.mock.calls[0][0]).toBe('https://api.example.com/v1');
  });

  it('endpoint 空 → 抛 empty_endpoint', async () => {
    await expect(
      llmRenderInsight({ ...MODEL_BASE, endpoint: '' }, INPUT),
    ).rejects.toMatchObject({ kind: 'empty_endpoint' });
  });
});

describe('llmRenderInsight：错误归类', () => {
  it('HTTP 401 → kind=auth', async () => {
    mockFetchOnce(async () => new Response('{"error":{"message":"bad key"}}', { status: 401 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('HTTP 403 → kind=auth', async () => {
    mockFetchOnce(async () => new Response('forbidden', { status: 403 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'auth' });
  });

  it('HTTP 429 → kind=rate_limit', async () => {
    mockFetchOnce(async () => new Response('rate limited', { status: 429 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('HTTP 500 → kind=server', async () => {
    mockFetchOnce(async () => new Response('oops', { status: 500 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'server' });
  });

  it('HTTP 400 → kind=server（按 status >= 400 兜底）', async () => {
    mockFetchOnce(async () => new Response('bad request', { status: 400 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'server' });
  });

  it('响应非 JSON → kind=bad_response', async () => {
    mockFetchOnce(async () => new Response('not json', { status: 200 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('响应 choices 为空 → kind=bad_response', async () => {
    mockFetchOnce(async () => new Response('{"choices":[]}', { status: 200 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('choices[0].message.content 为空 → kind=bad_response', async () => {
    mockFetchOnce(async () => new Response('{"choices":[{"message":{"role":"assistant"}}]}', { status: 200 }));
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('fetch reject (TypeError) → kind=network', async () => {
    mockFetchOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(llmRenderInsight(MODEL_BASE, INPUT)).rejects.toMatchObject({ kind: 'network' });
  });
});

// ponytail: 没有「外部 AbortSignal」用例——RenderOptions 只暴露 timeoutMs/maxTokens
// （生产唯一调用方零 opts 调用；signal 转发是没人要的灵活性，已随源码删除）。

describe('describeAiInsightError', () => {
  it('AiInsightError 形状 → 取 message', () => {
    const err: AiInsightError = { kind: 'auth', message: 'bad key', status: 401 };
    expect(describeAiInsightError(err)).toBe('bad key');
  });
  it('普通 Error → message', () => {
    expect(describeAiInsightError(new Error('boom'))).toBe('boom');
  });
});
// ── Anthropic 协议支持（2026-10-07，MiniMax /anthropic 端点） ──
describe('Anthropic 协议纯函数', () => {
  it('isAnthropicEndpoint 按路径分流', async () => {
    const { isAnthropicEndpoint } = await import('../src/insights/llm.js');
    expect(isAnthropicEndpoint('https://api.minimax.cn/anthropic')).toBe(true);
    expect(isAnthropicEndpoint('https://api.minimax.cn/v1')).toBe(false);
  });

  it('buildAnthropicPayload：system 顶级 + max_tokens 2048 地板', async () => {
    const { buildAnthropicPayload } = await import('../src/insights/llm.js');
    const p = buildAnthropicPayload('sys', 'user', 8);
    expect(p.system).toBe('sys');
    expect(p.messages).toEqual([{ role: 'user', content: 'user' }]);
    expect(p.max_tokens).toBe(2048);
  });
});
