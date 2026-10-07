/**
 * AI 客户端 Anthropic 协议支持的单测（2026-10-07）
 * 用户走 MiniMax 的 /anthropic 端点（Anthropic Messages API），
 * 这里钉死协议分流与 payload/解析纯函数。
 */
import { describe, it, expect } from 'vitest';
import {
  isAnthropicEndpoint,
  buildAnthropicPayload,
  parseAnthropicText,
} from '@/features/ai-assistant/client';

describe('isAnthropicEndpoint', () => {
  it('识别 /anthropic 路径（大小写不敏感）', () => {
    expect(isAnthropicEndpoint('https://api.minimax.cn/anthropic')).toBe(true);
    expect(isAnthropicEndpoint('https://x.com/Anthropic-proxy')).toBe(true);
  });
  it('OpenAI 兼容端点不误判', () => {
    expect(isAnthropicEndpoint('https://api.minimax.cn/v1')).toBe(false);
    expect(isAnthropicEndpoint('https://api.openai.com/v1')).toBe(false);
  });
});

describe('buildAnthropicPayload', () => {
  it('抽出首条 system 为顶级参数，messages 不含 system', () => {
    const p = buildAnthropicPayload(
      [
        { role: 'system', content: '你是助手' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
      ],
      8,
    );
    expect(p.system).toBe('你是助手');
    expect(p.max_tokens).toBe(2048); // 地板：thinking 预算
    expect(p.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
    ]);
  });

  it('无 system 时不带顶级参数；max_tokens 走 2048 地板（thinking 预算）', () => {
    const p = buildAnthropicPayload([{ role: 'user', content: 'ping' }]);
    expect('system' in p).toBe(false);
    expect(p.max_tokens).toBe(2048);
  });
});

describe('parseAnthropicText', () => {
  it('提取第一个 text 块', () => {
    expect(
      parseAnthropicText({
        content: [
          { type: 'thinking', text: '内部推理' },
          { type: 'text', text: '  最终答案  ' },
        ],
      }),
    ).toBe('最终答案');
  });
  it('无 text 块返回 null', () => {
    expect(parseAnthropicText({ content: [] })).toBeNull();
    expect(parseAnthropicText({})).toBeNull();
  });
});
