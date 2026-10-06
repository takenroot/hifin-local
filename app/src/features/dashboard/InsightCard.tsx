/**
 * 看板「AI 财务建议」卡（2026-10-06 用户立项）
 * ---------------------------------------------------------------
 * 手动触发的 AI 分析控件：点「分析现状」→ 把看板已有数据拼成上下文 →
 * 走 ai-assistant 的 chat() 生成「现状总结 + 三条建议」→ 结果缓存 kv
 * （ai.dashboard.advice，{text, at}）并展示生成时间。
 *
 * 状态机：checking（探测模型/缓存）→ no-model（引导去设置）/ ready /
 * loading（分析中，纯文字省略号）/ done（结果）/ error（可重试）。
 * 不做自动触发——用户掌控 token 消耗；不做硬配额——本地单用户，按需重分析。
 */
import { useCallback, useEffect, useState } from 'react';
import { IconSparkles } from '@tabler/icons-react';
import { chat } from '@/features/ai-assistant/client';
import { getDefaultModelId } from '@/features/ai-assistant/storage';
import type { LabMonthlyPoint } from '@/lib/monthlyAgg';

/** kv 缓存 key（与 ai-assistant 的 ai.* 命名空间同风格） */
export const INSIGHT_KV_KEY = 'ai.dashboard.advice';

export interface InsightCache {
  text: string;
  at: number;
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

export function DashboardInsightCard({ contextText }: { contextText: string }) {
  const [status, setStatus] = useState<Status>('checking');
  const [result, setResult] = useState<InsightCache | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

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
      const res = await chat(
        model as Parameters<typeof chat>[0],
        contextText,
        [],
        INSIGHT_TASK,
      );
      const cache: InsightCache = { text: res.text, at: Date.now() };
      await saveCache(cache);
      setResult(cache);
      setStatus('done');
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [contextText]);

  return (
    <div className="card p-5" data-testid="dash-insight">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-text dark:text-text-dark">AI 财务建议</h2>
          <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
            基于当前看板数据生成
          </p>
        </div>
        <IconSparkles size={16} className="text-text-muted dark:text-text-muted-dark" aria-hidden />
      </div>

      <div className="mt-3 text-sm" aria-live="polite">
        {status === 'checking' && (
          <div className="py-4 text-center text-text-muted dark:text-text-muted-dark">检测模型配置…</div>
        )}
        {status === 'no-model' && (
          <div className="py-4 text-center">
            <div className="text-text-muted dark:text-text-muted-dark">尚未配置 AI 模型</div>
            <a
              href="/settings"
              className="mt-2 inline-block text-brand dark:text-brand-dark underline underline-offset-2"
            >
              去设置 → AI 配置 添加模型
            </a>
          </div>
        )}
        {(status === 'ready' || status === 'error') && (
          <div className="py-2">
            {status === 'error' && (
              <div className="mb-2 text-expense dark:text-expense-dark" role="alert">
                {errorMsg || '分析失败'}
              </div>
            )}
            <button
              type="button"
              onClick={() => void analyze()}
              className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-brand text-white text-xs hover:opacity-90 transition"
            >
              <IconSparkles size={14} aria-hidden />
              {status === 'error' ? '重试分析' : '分析现状'}
            </button>
          </div>
        )}
        {status === 'loading' && (
          <div className="py-4 text-center text-text-muted dark:text-text-muted-dark">分析中…</div>
        )}
        {status === 'done' && result && (
          <div>
            <p className="whitespace-pre-wrap leading-relaxed text-text dark:text-text-dark">
              {result.text}
            </p>
            <div className="mt-3 flex items-center justify-between">
              <span className="text-[11px] text-text-muted dark:text-text-muted-dark">
                生成于 {new Date(result.at).toLocaleString('zh-CN', { hour12: false })}
              </span>
              <button
                type="button"
                onClick={() => void analyze()}
                className="text-xs text-brand dark:text-brand-dark hover:underline underline-offset-2"
              >
                重新分析
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default DashboardInsightCard;
