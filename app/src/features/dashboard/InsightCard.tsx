/**
 * 看板「AI 财务建议」卡（2026-10-07 C 方案：Hero 摘要卡 + 折叠全文 + 段落入场）
 * ---------------------------------------------------------------
 * 结构（替代初版"右栏窄条"——长文本撑高 grid 行把 Overview 图拉长，是布局错配）：
 *   全宽卡，「最近交易」之后。左文右数：
 *   - 左侧：标题 + 状态机（未配置引导/就绪/分析中/错误）+ 触发按钮
 *   - 右侧：3 枚指标 chip（净资产/本月结余/储蓄率）——Vuexy hero 的"指标化"
 *     借鉴，皮肤仍走我们的令牌（无营销页色块）
 *   - 完整分析文本默认折叠（「查看完整分析」展开），行宽 max-w-3xl，
 *     按段落 stagger 淡入上浮（--insight-delay 步进，reduced-motion 纯淡入）
 *
 * 其余不变：手动触发（用户掌控 token）、kv 缓存（ai.dashboard.advice）、
 * 复用 ai-assistant 的 chat()/getDefaultModelId()、上下文只用概况级数字。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconSparkles, IconChevronDown, IconChevronUp } from '@tabler/icons-react';
import { chat } from '@/features/ai-assistant/client';
import { getDefaultModelId } from '@/features/ai-assistant/storage';
import type { LabMonthlyPoint } from '@/lib/monthlyAgg';

/** kv 缓存 key（与 ai-assistant 的 ai.* 命名空间同风格） */
export const INSIGHT_KV_KEY = 'ai.dashboard.advice';

export interface InsightCache {
  text: string;
  at: number;
}

/** 右侧指标 chip 的数据形状（由看板用 stats/monthly 拼装） */
export interface InsightChip {
  label: string;
  value: string;
  /** 'income' | 'expense' | 缺省中性 */
  tone?: 'income' | 'expense';
}

/** 提示词中给模型的固定任务指令（口径：不编造数据） */
const INSIGHT_TASK =
  '请基于以上财务概况，用简体中文给出：1) 财务现状总结（3-5 句，只引用概况中出现的数字）；2) 三条可执行的建议。语气平实，不要用 emoji。';

/** 探测 + 模型读取共用的模型类型（与 /api/ai-models 行同构，仅取 chat 需要的字段） */
interface ModelRow {
  id?: number;
  name?: string;
  model?: string;
  endpoint?: string;
  apiKey?: string;
}

/** 拼装模型可读的上下文文本（纯函数可测）：只用概况级数字，不塞原始流水 */
export function buildInsightContext(input: {
  netAsset: number;
  savingsRate: number;
  monthly: LabMonthlyPoint[];
  budgets: ReadonlyArray<{ name: string; spent: number; amount: number }>;
  goals: ReadonlyArray<{ name: string; current: number; target: number }>;
}): string {
  const { netAsset, savingsRate, monthly, budgets, goals } = input;
  const last = monthly[monthly.length - 1];
  const lines: string[] = [
    `- 当前净资产：${netAsset.toFixed(2)} 元`,
    `- 本月（${last.month}）：收入 ${last.income.toFixed(2)}，支出 ${last.expense.toFixed(2)}，结余 ${last.balance.toFixed(2)}，储蓄率 ${savingsRate.toFixed(1)}%`,
    `- 近 12 个月收支（元）：${monthly
      .map((m) => `${m.month} 收${m.income.toFixed(0)}/支${m.expense.toFixed(0)}`)
      .join('；')}`,
  ];
  if (budgets.length > 0) {
    lines.push(
      `- 预算执行：${budgets
        .map((b) => `${b.name} 已花 ${b.spent.toFixed(2)}/${b.amount.toFixed(2)}`)
        .join('；')}`,
    );
  }
  if (goals.length > 0) {
    lines.push(
      `- 目标进度：${goals
        .map((g) => `${g.name} ${g.current.toFixed(2)}/${g.target.toFixed(2)}`)
        .join('；')}`,
    );
  }
  return lines.join('\n');
}

/** 把模型文本按空行拆成段落（stagger 淡入的渲染单位）；无空行整篇一段 */
export function splitInsightParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

async function fetchModel(id: number): Promise<ModelRow | undefined> {
  const r = await fetch('/api/ai-models?hideApiKey=0');
  if (!r.ok) throw new Error(`GET /api/ai-models → ${r.status}`);
  const rows = (await r.json()) as ModelRow[];
  return rows.find((m) => Number(m.id) === id);
}

async function loadCache(): Promise<InsightCache | null> {
  try {
    const r = await fetch(`/api/kv/${INSIGHT_KV_KEY}`);
    if (!r.ok) return null;
    const body = (await r.json()) as { value?: unknown } | null;
    const v = body?.value as InsightCache | undefined;
    return v && typeof v.text === 'string' && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}

async function saveCache(cache: InsightCache): Promise<void> {
  await fetch(`/api/kv/${INSIGHT_KV_KEY}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: cache }),
  });
}

type Status = 'checking' | 'no-model' | 'ready' | 'loading' | 'done' | 'error';

export function DashboardInsightCard({
  contextText,
  chips,
}: {
  contextText: string;
  chips: InsightChip[];
}) {
  const [status, setStatus] = useState<Status>('checking');
  const [result, setResult] = useState<InsightCache | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const [expanded, setExpanded] = useState(false);

  // 启动探测：默认模型 → 模型存在才允许分析；缓存优先展示
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const modelId = await getDefaultModelId();
        const cached = await loadCache();
        if (cancelled) return;
        if (cached) {
          setResult(cached);
          setStatus(modelId != null ? 'done' : 'no-model');
        } else {
          setStatus(modelId != null ? 'ready' : 'no-model');
        }
      } catch {
        if (!cancelled) setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const analyze = useCallback(async () => {
    setStatus('loading');
    setErrorMsg('');
    try {
      const modelId = await getDefaultModelId();
      if (modelId == null) {
        setStatus('no-model');
        return;
      }
      const model = await fetchModel(modelId);
      if (!model) throw new Error('默认模型已不存在，请到设置重新选择');
      const res = await chat(model as Parameters<typeof chat>[0], contextText, [], INSIGHT_TASK);
      const cache: InsightCache = { text: res.text, at: Date.now() };
      await saveCache(cache);
      setResult(cache);
      setExpanded(true); // 新生成的结果直接展开（stagger 入场是它的一部分）
      setStatus('done');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [contextText]);

  const paragraphs = useMemo(() => (result ? splitInsightParagraphs(result.text) : []), [result]);

  return (
    <section className="card p-5" data-testid="dash-insight">
      <div className="flex flex-col gap-6 md:flex-row md:items-start">
        {/* 左文：标题 + 状态机 + 触发 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">AI 财务建议</h2>
            <IconSparkles size={14} className="text-text-muted dark:text-text-muted-dark" aria-hidden />
          </div>
          <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
            基于当前看板数据生成
          </p>

          <div className="mt-3 text-sm" aria-live="polite">
            {status === 'checking' && (
              <div className="text-text-muted dark:text-text-muted-dark">检测模型配置…</div>
            )}
            {status === 'no-model' && (
              <div>
                <span className="text-text-muted dark:text-text-muted-dark">尚未配置 AI 模型。</span>
                <a
                  href="/settings"
                  className="ml-1 text-brand dark:text-brand-dark underline underline-offset-2"
                >
                  去设置 → AI 配置
                </a>
              </div>
            )}
            {(status === 'ready' || status === 'error') && (
              <div className="flex items-center gap-3">
                {status === 'error' && (
                  <span className="text-expense dark:text-expense-dark" role="alert">
                    {errorMsg || '分析失败'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => void analyze()}
                  className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-brand text-white text-xs hover:opacity-90 transition whitespace-nowrap"
                >
                  <IconSparkles size={14} aria-hidden />
                  {status === 'error' ? '重试分析' : '分析现状'}
                </button>
              </div>
            )}
            {status === 'loading' && (
              <div className="text-text-muted dark:text-text-muted-dark">分析中…</div>
            )}
            {status === 'done' && result && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted dark:text-text-muted-dark">
                <span>生成于 {new Date(result.at).toLocaleString('zh-CN', { hour12: false })}</span>
                <button
                  type="button"
                  onClick={() => void analyze()}
                  className="text-brand dark:text-brand-dark hover:underline underline-offset-2 whitespace-nowrap"
                >
                  重新分析
                </button>
              </div>
            )}
          </div>
        </div>

        {/* 右数：指标 chip（Hero 摘要位；Vuexy 的"指标化"借鉴，皮肤走我们的令牌） */}
        <div className="grid grid-cols-3 gap-3 md:w-96 flex-none" data-testid="dash-insight-chips">
          {chips.map((c) => (
            <div
              key={c.label}
              className="rounded-xl bg-bg dark:bg-bg-dark px-3 py-2.5 text-center"
            >
              <div className="text-[11px] text-text-muted dark:text-text-muted-dark truncate">
                {c.label}
              </div>
              <div
                className={
                  'mt-0.5 text-sm font-semibold tabular-nums truncate ' +
                  (c.tone === 'income'
                    ? 'text-income'
                    : c.tone === 'expense'
                      ? 'text-expense'
                      : 'text-text dark:text-text-dark')
                }
                title={c.value}
              >
                {c.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 全文折叠区：max-w-3xl 限行长；按段落 stagger 淡入（CSS 见 index.css .insight-para） */}
      {status === 'done' && result && (
        <div className="mt-4 border-t border-border dark:border-border-dark pt-3">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition whitespace-nowrap"
          >
            {expanded ? (
              <>
                收起分析 <IconChevronUp size={12} />
              </>
            ) : (
              <>
                查看完整分析（{paragraphs.length} 段） <IconChevronDown size={12} />
              </>
            )}
          </button>
          {expanded && (
            <div className="mt-2 max-w-3xl">
              {paragraphs.map((p, i) => (
                <p
                  key={i}
                  className="insight-para whitespace-pre-wrap leading-relaxed text-text dark:text-text-dark mb-3 last:mb-0"
                  style={{ '--insight-delay': `${i * 120}ms` } as React.CSSProperties}
                >
                  {/* 模型常输出 markdown 标题记号（### 1) …）——渲染时剥掉井号，
                     保留序号文本；正文其它 markdown 不做解析（YAGNI） */}
                  {p.replace(/^#{1,6}\s*/, '')}
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export default DashboardInsightCard;
