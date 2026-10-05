/**
 * AI 洞察 store — 通知写入后的两阶段提交工具。
 *
 * 设计：先 createNotification 落一条 payload.llmNarrative=null 的规则版通知，
 * LLM 异步完成后 UPDATE 同一行的 llmNarrative。
 * 这里只暴露 UPDATE 这一脚，避免在 scheduler 里直接拼 SQL。
 */
import type Database from 'better-sqlite3';
import { parseNotificationPayload } from '../notifications/store.js';
import type { NotificationRow } from '../db/schema.js';

/** ai-insight 通知 payload 的结构化类型（与设计文档 §3.1 一致） */
export interface AiInsightPayload {
  kind: 'monthly' | 'anomaly' | 'budget' | 'category-mom';
  month?: string;
  summary: string;
  sections: Array<{
    title: string;
    metric: Array<{ key: string; value: string }>;
    tone: 'neutral' | 'good' | 'warning' | 'danger';
  }>;
  llmNarrative: string | null;
  source: 'auto' | 'manual';
  modelId?: number;
  generatedAt: number;
}

/** 从 SQLite 行读回结构化 payload；脏数据返回 null。 */
export function readInsightPayload(
  row: Pick<NotificationRow, 'payload'>,
): AiInsightPayload | null {
  const parsed = parseNotificationPayload(row);
  if (parsed === null) return null;
  if (typeof parsed.llmNarrative !== 'string' && parsed.llmNarrative !== null) return null;
  return parsed as unknown as AiInsightPayload;
}

/**
 * 只更新 llmNarrative 字段（其它字段保持不变）。两阶段提交的第二步。
 * 找不到 id 时返回 false，路由层据此转 404；存在则返回 true。
 */
export function updateInsightNarrative(
  db: Database.Database,
  id: number,
  llmNarrative: string,
): boolean {
  const row = db
    .prepare("SELECT payload FROM notifications WHERE id = ? AND type = 'ai-insight'")
    .get(id) as { payload: string | null } | undefined;
  if (!row) return false;
  const parsed = parseNotificationPayload(row);
  if (parsed === null) return false;
  const next = { ...parsed, llmNarrative };
  db.prepare('UPDATE notifications SET payload = ?, updatedAt = ? WHERE id = ?').run(
    JSON.stringify(next),
    Date.now(),
    id,
  );
  return true;
}