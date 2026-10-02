/**
 * AI 助手 → 会话存储（REST /api/kv/:key，替代 Dexie db.kv）
 *
 * 仅保留最近 20 条；每次追加后自动截断；旧的 assistant 占位未实际回填前不会持久化。
 *
 * 键：
 *   ai.conversation.v1 → ChatMessage[]
 *   ai.defaultModelId  → number | undefined
 *
 * core 的 GET /api/kv/:key 对不存在的键返回 404，这里归一为 undefined（= 未设置）。
 * DELETE /api/kv/:key 返回 204 空体，因此删除走原生 fetch 而不是 apiFetch。
 */
import type { ChatMessage } from './client';

const KV_CONVERSATION = 'ai.conversation.v1';
const KV_DEFAULT_MODEL = 'ai.defaultModelId';
const MAX_MESSAGES = 20;

interface KvEnvelope {
  key: string;
  value: unknown;
}

function kvUrl(key: string): string {
  return `/api/kv/${encodeURIComponent(key)}`;
}

/** 读取一个 kv 键；404（键不存在）归一为 undefined。 */
async function getKv<T>(key: string): Promise<T | undefined> {
  const r = await fetch(kvUrl(key));
  if (r.status === 404) return undefined;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const row = (await r.json()) as KvEnvelope;
  return row.value as T;
}

async function setKv(key: string, value: unknown): Promise<void> {
  const r = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

/** DELETE 返回 204 空体 / 404 幂等，都算成功。 */
async function deleteKv(key: string): Promise<void> {
  const r = await fetch(kvUrl(key), { method: 'DELETE' });
  if (r.status === 204 || r.status === 404) return;
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

/** 读取当前会话（自动剔除非 ChatMessage 形状的脏数据） */
export async function loadConversation(): Promise<ChatMessage[]> {
  const raw = (await getKv<unknown>(KV_CONVERSATION)) ?? [];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (m): m is ChatMessage =>
      !!m &&
      typeof m === 'object' &&
      (m.role === 'user' || m.role === 'assistant') &&
      typeof m.content === 'string',
  );
}

/** 追加并持久化（自动截断到最近 20 条） */
export async function appendConversation(messages: ChatMessage[]): Promise<ChatMessage[]> {
  const cur = await loadConversation();
  const next = [...cur, ...messages];
  const trimmed = next.slice(-MAX_MESSAGES);
  await setKv(KV_CONVERSATION, trimmed);
  return trimmed;
}

/** 用最新一轮替换整段（用于「重新生成」或修改历史） */
export async function saveConversation(messages: ChatMessage[]): Promise<void> {
  const trimmed = messages.slice(-MAX_MESSAGES);
  await setKv(KV_CONVERSATION, trimmed);
}

/** 清空会话 */
export async function clearConversation(): Promise<void> {
  await deleteKv(KV_CONVERSATION);
}

/** 默认模型 id */
export async function getDefaultModelId(): Promise<number | undefined> {
  const v = await getKv<unknown>(KV_DEFAULT_MODEL);
  return typeof v === 'number' ? v : undefined;
}

export async function setDefaultModelId(id: number | undefined): Promise<void> {
  if (id == null) {
    await deleteKv(KV_DEFAULT_MODEL);
    return;
  }
  await setKv(KV_DEFAULT_MODEL, id);
}
