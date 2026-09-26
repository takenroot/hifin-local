/**
 * AI 助手页 /ai
 *
 * - 左侧：模型选择（读 aiModels 表，空则引导到设置页）
 * - 中部：对话区（用户 / 助手 / 流式/非流式）
 * - 底部：输入框（Enter 发送，Shift+Enter 换行）
 *
 * 默认关闭：未配置任何模型时只显示配置引导，不发起任何请求。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import dayjs from 'dayjs';
import clsx from 'clsx';
import {
  IconRobot,
  IconSettings,
  IconSend,
  IconTrash,
  IconUser,
  IconAlertTriangle,
  IconRefresh,
} from '@tabler/icons-react';
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  Select,
  Textarea,
} from '@/components/ui';
import { db, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { buildFinancialSnapshot, snapshotToText } from './aggregate';
import { chat, describeAiError, type ChatMessage } from './client';
import {
  appendConversation,
  clearConversation,
  getDefaultModelId,
  loadConversation,
  saveConversation,
  setDefaultModelId,
} from './storage';

export default function AssistantPage() {
  const navigate = useNavigate();

  const models = useLiveQuery(() => db.aiModels.orderBy('name').toArray(), []) ?? [];
  const accountsAll = useLiveQuery(() => db.accounts.toArray(), []) ?? [];
  const transactionsAll = useLiveQuery(() => db.transactions.toArray(), []) ?? [];
  const goalsAll = useLiveQuery(() => db.goals.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const spaceId = useSpaceId();
  // AI 聚合用当前空间的数据（sid=0 不过滤）
  const accounts = useMemo(() => filterBySpace(accountsAll, spaceId), [accountsAll, spaceId]);
  const transactions = useMemo(() => filterBySpace(transactionsAll, spaceId), [transactionsAll, spaceId]);
  const goals = useMemo(() => filterBySpace(goalsAll, spaceId), [goalsAll, spaceId]);

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // 默认模型 id → 初始选中
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const def = await getDefaultModelId();
      if (!mounted) return;
      if (def != null && models.some((m) => m.id === def)) {
        setSelectedId(def);
      } else if (models.length > 0 && selectedId == null) {
        setSelectedId(models[0].id ?? null);
      }
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models.length]);

  // 加载历史会话
  useEffect(() => {
    let mounted = true;
    void (async () => {
      const hist = await loadConversation();
      if (mounted) {
        setMessages(hist);
        setHydrated(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // 滚动到底部
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length, sending]);

  // 卸载时取消未完成请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const selectedModel = useMemo(
    () => models.find((m) => m.id === selectedId) ?? null,
    [models, selectedId],
  );

  // 实时财务快照（每次进入都聚合一次，提交时再聚合确保最新）
  const snapshotText = useMemo(() => {
    const snap = buildFinancialSnapshot({
      accounts,
      transactions,
      goals,
      categories,
    });
    return snapshotToText(snap);
  }, [accounts, transactions, goals, categories]);

  /** 切换模型：写入默认 id */
  async function handleSelectModel(id: number) {
    setSelectedId(id);
    setError(null);
    await setDefaultModelId(id);
  }

  async function send() {
    if (!selectedModel) {
      setError('请先选择 AI 模型。');
      return;
    }
    const text = input.trim();
    if (!text || sending) return;

    setError(null);
    const userMsg: ChatMessage = { role: 'user', content: text };
    const placeholderAssistant: ChatMessage = { role: 'assistant', content: '' };
    const draftHistory = [...messages, userMsg, placeholderAssistant];
    setMessages(draftHistory);
    setInput('');
    setSending(true);

    // 持久化：保留最近 20 条
    void appendConversation([userMsg]);

    // 构造发给模型的历史（不包含占位 assistant）
    const historyForModel = messages.slice(-18); // 留余量给 system/最新

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await chat(selectedModel, snapshotText, historyForModel, text, {
        signal: controller.signal,
      });
      const assistantMsg: ChatMessage = { role: 'assistant', content: result.text };
      const final = [...messages, userMsg, assistantMsg];
      setMessages(final);
      await saveConversation(final);
    } catch (e) {
      const msg = describeAiError(e);
      setError(msg);
      // 移除占位 assistant，保留用户消息
      setMessages(messages);
      // 用户消息已写入历史，避免连续失败堆积 → 直接清除（保留上一轮）
      await clearConversation();
      // 重新写入当前消息之前的会话（已在 messages 变量中）
      if (messages.length > 0) {
        await saveConversation(messages);
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  async function regenerate() {
    if (!selectedModel || sending) return;
    // 找到最后一组 user/assistant；如果最后一条是 user（上次失败残留），则尝试基于它重新生成
    if (messages.length === 0) return;
    const last = messages[messages.length - 1];
    let userMsg: ChatMessage | undefined;
    let baseMessages: ChatMessage[] = [];
    if (last.role === 'user') {
      userMsg = last;
      baseMessages = messages.slice(0, -1);
    } else if (last.role === 'assistant') {
      // 找它前面的 user
      for (let i = messages.length - 2; i >= 0; i--) {
        if (messages[i].role === 'user') {
          userMsg = messages[i];
          baseMessages = messages.slice(0, i);
          break;
        }
      }
    }
    if (!userMsg) return;

    setError(null);
    setSending(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await chat(
        selectedModel,
        snapshotText,
        baseMessages.slice(-18),
        userMsg.content,
        { signal: controller.signal },
      );
      const assistantMsg: ChatMessage = { role: 'assistant', content: result.text };
      const final: ChatMessage[] = [...baseMessages, userMsg, assistantMsg];
      setMessages(final);
      await saveConversation(final);
    } catch (e) {
      setError(describeAiError(e));
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  async function handleClear() {
    if (sending) return;
    setMessages([]);
    setError(null);
    await clearConversation();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  }

  // ────────────── 渲染分支 ──────────────

  // 1) 未配置模型 → 配置引导（不发起任何请求）
  if (hydrated && models.length === 0) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="AI 助手"
          icon={<IconRobot size={18} />}
          description="本地默认关闭，需手动配置模型后启用"
        />
        <div className="p-6 lg:p-8 max-w-[960px] mx-auto">
          <Card>
            <EmptyState
              illustration={<IconRobot size={64} className="text-text-muted" />}
              title="尚未配置 AI 模型"
              description={
                'AI 助手默认关闭。\n' +
                '本地版本不会向任何服务器主动发起请求，\n' +
                '只有当您在「设置 → AI 配置」中新增并启用模型后，\n' +
                '本页才会发起调用。'
              }
              action={
                <Button
                  variant="primary"
                  icon={<IconSettings size={16} />}
                  onClick={() => navigate('/settings?section=ai')}
                >
                  前往配置
                </Button>
              }
            />
          </Card>
        </div>
      </div>
    );
  }

  // 2) 已配置 → 聊天界面
  const modelOptions = models.map((m) => ({
    label: m.name ? `${m.name}（${m.model}）` : m.model,
    value: String(m.id ?? ''),
  }));

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark flex flex-col">
      <PageHeader
        title="AI 助手"
        icon={<IconRobot size={18} />}
        description="基于本地财务数据对话（默认关闭）"
        actions={
          messages.length > 0 ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<IconTrash size={14} />}
              onClick={handleClear}
              disabled={sending}
            >
              清空对话
            </Button>
          ) : undefined
        }
      />

      <div className="flex-1 px-6 lg:px-8 py-4 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 max-w-[1280px] w-full mx-auto">
        {/* 左侧：模型选择 + 概览 */}
        <aside className="space-y-4">
          <Card title="模型">
            <div className="space-y-2">
              <Select
                value={selectedId != null ? String(selectedId) : ''}
                onChange={(e) => {
                  const id = Number(e.target.value);
                  if (!Number.isNaN(id)) void handleSelectModel(id);
                }}
                options={modelOptions}
                placeholder="请选择模型"
              />
              {selectedModel && (
                <div className="text-xs text-text-muted space-y-1 pt-1">
                  <div className="truncate">模型：{selectedModel.model || '—'}</div>
                  <div className="truncate">地址：{selectedModel.endpoint || '—'}</div>
                </div>
              )}
            </div>
          </Card>

          <Card title="财务概况（只读）">
            <pre className="text-[11px] leading-snug text-text-muted dark:text-text-muted-dark whitespace-pre-wrap break-words font-mono">
              {snapshotText}
            </pre>
          </Card>

          <Card>
            <Button
              variant="secondary"
              size="sm"
              block
              icon={<IconSettings size={14} />}
              onClick={() => navigate('/settings?section=ai')}
            >
              管理模型
            </Button>
          </Card>
        </aside>

        {/* 中部：对话区 */}
        <section className="card flex flex-col overflow-hidden">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto p-4 space-y-3 min-h-[360px] max-h-[calc(100vh-220px)]"
          >
            {messages.length === 0 && !sending ? (
              <div className="h-full flex items-center justify-center text-center text-text-muted py-16">
                <div>
                  <div className="text-base mb-2">开始与 AI 助手对话</div>
                  <div className="text-xs">它能根据你当前的财务概况回答问题</div>
                </div>
              </div>
            ) : (
              messages.map((m, i) => (
                <Bubble
                  key={i}
                  role={m.role === 'assistant' ? 'assistant' : 'user'}
                  content={m.content}
                />
              ))
            )}
            {sending && (
              <Bubble
                role="assistant"
                content=""
                pending
              />
            )}
          </div>

          {error && (
            <div className="mx-4 mb-2 text-xs text-expense bg-expense-soft dark:bg-expense-soft-dark px-3 py-2 rounded-lg flex items-start gap-2">
              <IconAlertTriangle size={14} className="flex-none mt-0.5" />
              <div className="flex-1 break-words">{error}</div>
              <button
                type="button"
                className="text-text-muted hover:text-text dark:hover:text-text-dark"
                onClick={() => setError(null)}
                title="关闭"
              >
                ×
              </button>
            </div>
          )}

          {/* 输入区 */}
          <div className="border-t border-border dark:border-border-dark p-3 space-y-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                selectedModel
                  ? '输入消息，Enter 发送，Shift+Enter 换行'
                  : '请先在左侧选择一个模型'
              }
              disabled={!selectedModel || sending}
              rows={2}
            />
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-text-muted">
                最近 {messages.length} 条 / 最多 20 条
              </div>
              <div className="flex items-center gap-2">
                {messages.length > 0 &&
                  !sending &&
                  messages[messages.length - 1]?.role === 'assistant' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<IconRefresh size={14} />}
                      onClick={() => void regenerate()}
                    >
                      重新生成
                    </Button>
                  )}
                <Button
                  variant="primary"
                  size="sm"
                  icon={<IconSend size={14} />}
                  disabled={!selectedModel || sending || !input.trim()}
                  onClick={() => void send()}
                >
                  发送
                </Button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

/* ────────────── 单条气泡 ────────────── */

function Bubble({
  role,
  content,
  pending,
}: {
  role: 'user' | 'assistant';
  content: string;
  pending?: boolean;
}) {
  const isUser = role === 'user';
  return (
    <div className={clsx('flex gap-2 items-start', isUser && 'flex-row-reverse')}>
      <div
        className={clsx(
          'w-7 h-7 rounded-lg flex-none flex items-center justify-center',
          isUser
            ? 'bg-bg-card dark:bg-bg-card-dark text-text dark:text-text-dark border border-border dark:border-border-dark'
            : 'bg-brand-soft text-brand',
        )}
        title={isUser ? '你' : 'AI'}
      >
        {isUser ? <IconUser size={14} /> : <IconRobot size={14} />}
      </div>
      <div
        className={clsx(
          'max-w-[78%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words',
          isUser
            ? 'bg-bg-card dark:bg-bg-card-dark border border-border dark:border-border-dark'
            : 'bg-bg dark:bg-bg-dark border border-border dark:border-border-dark',
        )}
      >
        {pending ? (
          <span className="inline-flex items-center gap-1 text-text-muted">
            <Dot delay={0} />
            <Dot delay={150} />
            <Dot delay={300} />
          </span>
        ) : (
          <span>{content}</span>
        )}
        {!pending && (
          <div className="mt-1 text-[10px] text-text-muted">
            {dayjs().format('HH:mm')}
          </div>
        )}
      </div>
    </div>
  );
}

function Dot({ delay }: { delay: number }) {
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full bg-text-muted animate-bounce"
      style={{ animationDelay: `${delay}ms` }}
    />
  );
}