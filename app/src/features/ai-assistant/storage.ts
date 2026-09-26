/**
 * AI 助手 → 会话存储（kv 表）
 *
 * 仅保留最近 20 条；每次追加后自动截断；旧的 assistant 占位未实际回填前不会持久化。
 *
 * 键：
 *   ai.conversation.v1 → ChatMessage[]
 *   ai.defaultModelId  → number | undefined
 */
import { db, type KvItem } from '@/db';
import type { ChatMessage } from './client';

const KV_CONVERSATION = 'ai.conversation.v1';
const KV_DEFAULT_MODEL = 'ai.defaultModelId';
const MAX_MESSAGES = 20;

async function getKv(key: string): Promise<KvItem | undefined> {
  return db.kv.get(key);
}

async function setKv(key: string, value: unknown): Promise<void> {
  await db.kv.put({ key, value });
}

/** 读取当前会话（自动剔除非 ChatMessage 形状的脏数据） */
export async function loadConversation(): Promise<ChatMessage[]> {
  const row = await getKv(KV_CONVERSATION);
  const raw = (row?.value as unknown) ?? [];
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
  await db.kv.delete(KV_CONVERSATION);
}

/** 默认模型 id */
export async function getDefaultModelId(): Promise<number | undefined> {
  const row = await getKv(KV_DEFAULT_MODEL);
  const v = row?.value;
  return typeof v === 'number' ? v : undefined;
}

export async function setDefaultModelId(id: number | undefined): Promise<void> {
  if (id == null) {
    await db.kv.delete(KV_DEFAULT_MODEL);
    return;
  }
  await setKv(KV_DEFAULT_MODEL, id);
}