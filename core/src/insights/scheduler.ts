/**
 * AI 洞察月度调度器
 * -----------------------------------------------------------------
 * 设计文档 docs/ai-insights-design.md §3.2 / §2.4。
 *
 * 三个不变量：
 *  1. 同月份已有 ai-insight → 跳过（同月去重，无需再产）。
 *  2. 未配 aiModels → 只产规则版、跳过 LLM（"本地默认关闭"承诺）。
 *  3. LLM 失败 → log + UPDATE 失败都只 console.error，**不删通知**；
 *     用户至少能读到规则版同步进度条式的安全降级版。
 *
 * 仿照 yields/reminder.ts 的"立刻 + 24h + 幂等"调度模式，注释也解释"为什么这么做"。
 */
import type Database from 'better-sqlite3';
import type { AiModelRow, KvRow } from '../db/schema.js';
import {
  createNotification,
  listNotifications,
} from '../notifications/store.js';
import type { MonthMetrics } from './metrics.js';
import { computeMonthMetrics } from './metrics.js';
import { llmRenderInsight, describeAiInsightError } from './llm.js';
import {
  updateInsightNarrative,
  type AiInsightPayload,
} from './store.js';

/** 通知 type 契约 */
export const AI_INSIGHT_TYPE = 'ai-insight';

/** 同月份去重窗口：同月份生成的 ai-insight 在窗口期内不重生（默认 7 天） */
export const INSIGHT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 自动调度周期：与 yield-reminder 一致的 24h */
export const AI_INSIGHT_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** 通知标题 — 遵守"未配模型时不强调 AI"原则 */
export const INSIGHT_TITLE = '本月财务小结';

/** 手动生成每月配额上限 */
export const AI_INSIGHT_MANUAL_QUOTA = 3;

/** 手动配额 kv key 前缀；实际 key = `ai.insights.manualCount.${YYYY-MM}` */
export const MANUAL_COUNT_KEY_PREFIX = 'ai.insights.manualCount.';

/** 默认模型 id 覆盖 kv key（与 ai-assistant 一致；null 表示未设置） */
export const DEFAULT_MODEL_KV_KEY = 'ai.defaultModelId';

/** 单条月运行结果 */
export interface InsightRun {
  generated: 0 | 1;
  reused?: number;
  skippedReason?: 'dedupe' | 'no-model' | 'no-data' | 'quota-exceeded';
  notificationId?: number;
  /** 目标月份 YYYY-MM（供日志/调用方展示） */
  month?: string;
  /** 同步阶段后是否发起了 LLM 调用（异步结果不一定成功） */
  llmAttempted: boolean;
}

/** 把 month 转成 YYYY-MM：now 所在月 */
export function currentMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 把 month 转成 YYYY-MM 上一个月 */
function previousMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  let year = Number(m[1]);
  let mo = Number(m[2]);
  mo -= 1;
  if (mo === 0) {
    mo = 12;
    year -= 1;
  }
  return `${year}-${String(mo).padStart(2, '0')}`;
}

/**
 * 同月份最近一条 ai-insight 通知（任意 status）。
 * payload JSON LIKE 走的是字符串匹配，避开 SQLite 不同编译期下 json_extract 行为差异。
 */
function latestForMonth(
  db: Database.Database,
  month: string,
): { id: number; createdAt: number; status: string } | null {
  const rows = listNotifications(db, { type: AI_INSIGHT_TYPE }) as Array<{
    id: number;
    createdAt: number;
    status: string;
    payload?: string | null;
  }>;
  const needle = `"month":"${month}"`;
  let best: { id: number; createdAt: number; status: string } | null = null;
  for (const r of rows) {
    if (typeof r.payload !== 'string' || !r.payload.includes(needle)) continue;
    if (best === null || r.createdAt > best.createdAt) {
      best = { id: r.id, createdAt: r.createdAt, status: r.status };
    }
  }
  return best;
}

/**
 * 默认模型：读 aiModels ORDER BY id ASC LIMIT 1，再用 kv:'ai.defaultModelId' 覆盖。
 * 沿用 ai-assistant 的语义（设计文档 §2.3）。
 */
export function pickDefaultModel(db: Database.Database): AiModelRow | null {
  const first = db
    .prepare('SELECT * FROM aiModels ORDER BY id ASC LIMIT 1')
    .get() as AiModelRow | undefined;
  if (!first) return null;
  const kv = db
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(DEFAULT_MODEL_KV_KEY) as KvRow | undefined;
  if (!kv?.value) return first;
  const id = Number(JSON.parse(kv.value));
  if (!Number.isFinite(id) || id <= 0) return first;
  const override = db
    .prepare('SELECT * FROM aiModels WHERE id = ?')
    .get(id) as AiModelRow | undefined;
  return override ?? first;
}

/** 读本月手动生成次数（手动触发用；自动调度不计入） */
export function getManualCount(db: Database.Database, month: string): number {
  const row = db
    .prepare('SELECT value FROM kv WHERE key = ?')
    .get(MANUAL_COUNT_KEY_PREFIX + month) as KvRow | undefined;
  if (!row?.value) return 0;
  const n = Number(JSON.parse(row.value));
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function bumpManualCount(db: Database.Database, month: string): number {
  const key = MANUAL_COUNT_KEY_PREFIX + month;
  const next = getManualCount(db, month) + 1;
  db.prepare(
    `INSERT INTO kv (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(next));
  return next;
}

/** 把 MonthMetrics 压平成"结构化 sections + 中文 summary"，便于前端展示与喂 LLM */
export function renderRuleNarrative(metrics: MonthMetrics): {
  summary: string;
  sections: AiInsightPayload['sections'];
} {
  const fmt = (n: number): string => n.toFixed(2);
  const sections: AiInsightPayload['sections'] = [];

  sections.push({
    title: '收支',
    tone: metrics.net >= 0 ? 'good' : 'warning',
    metric: [
      { key: '收入', value: `¥${fmt(metrics.income)}` },
      { key: '支出', value: `¥${fmt(metrics.expense)}` },
      { key: '结余', value: `${metrics.net >= 0 ? '+' : ''}¥${fmt(metrics.net)}` },
      {
        key: '环比',
        value: metrics.momPct == null ? '上月为 0' : `${metrics.momPct >= 0 ? '+' : ''}${metrics.momPct.toFixed(1)}%`,
      },
    ],
  });

  if (metrics.topExpense.length > 0) {
    sections.push({
      title: '支出 TOP 3',
      tone: 'neutral',
      metric: metrics.topExpense.map((c) => ({
        key: c.name,
        value: `¥${fmt(c.amount)} (${c.pct.toFixed(1)}%)`,
      })),
    });
  }

  if (metrics.largest) {
    sections.push({
      title: '单笔最大',
      tone: 'warning',
      metric: [
        { key: '名称', value: metrics.largest.name },
        { key: '金额', value: `¥${fmt(metrics.largest.amount)}` },
      ],
    });
  }

  if (metrics.budgetAlerts.length > 0) {
    sections.push({
      title: '预算告警',
      tone: 'danger',
      metric: metrics.budgetAlerts.map((b) => ({
        key: b.name,
        value: `${b.pct.toFixed(0)}%（¥${fmt(b.spent)}/¥${fmt(b.amount)}）`,
      })),
    });
  }

  if (metrics.goalsNear.length > 0) {
    sections.push({
      title: '30 天内到期',
      tone: 'warning',
      metric: metrics.goalsNear.map((g) => ({
        key: g.name,
        value: `${g.deadline ? new Date(g.deadline).toISOString().slice(0, 10) : ''}（${g.currentAmount}/${g.targetAmount}）`,
      })),
    });
  }

  if (metrics.anomalyLarge.length > 0) {
    sections.push({
      title: '异常大额',
      tone: 'warning',
      metric: metrics.anomalyLarge.slice(0, 3).map((a) => ({
        key: a.name,
        value: `¥${fmt(a.amount)}（${a.ratioToAvg.toFixed(1)}× 月均）`,
      })),
    });
  }

  // 摘要：拼接成 ≤ 200 字中文短文
  const parts: string[] = [];
  parts.push(`${metrics.month}：收入 ¥${fmt(metrics.income)}，支出 ¥${fmt(metrics.expense)}，结余 ¥${fmt(metrics.net)}。`);
  if (metrics.momPct != null) {
    parts.push(`净收支环比 ${metrics.momPct >= 0 ? '+' : ''}${metrics.momPct.toFixed(1)}%。`);
  }
  if (metrics.topExpense[0]) {
    parts.push(`支出最大的是「${metrics.topExpense[0].name}」¥${fmt(metrics.topExpense[0].amount)}。`);
  }
  if (metrics.budgetAlerts.length > 0) {
    parts.push(`预算告警 ${metrics.budgetAlerts.length} 项；`);
  }
  if (metrics.goalsNear.length > 0) {
    parts.push(`目标到期 ${metrics.goalsNear.length} 项；`);
  }
  if (metrics.anomalyLarge.length > 0) {
    parts.push(`异常大额 ${metrics.anomalyLarge.length} 笔。`);
  }
  return { summary: parts.join('').slice(0, 200), sections };
}

/** 写一条 ai-insight 通知（payload.llmNarrative=null，规则版内容先落） */
function createInsightNotification(
  db: Database.Database,
  month: string,
  payload: AiInsightPayload,
): { id: number } {
  const row = createNotification(db, {
    type: AI_INSIGHT_TYPE,
    title: INSIGHT_TITLE,
    message: payload.summary,
    payload,
  });
  return { id: row.id as number };
}

/** 自动调度核心：立刻跑一次 `ensureMonthlyInsight`，逻辑与 manual 同源但跳过配额检查 */
export function ensureMonthlyInsight(
  db: Database.Database,
  now: Date,
): InsightRun {
  // 自动调度生成的是"上一个月"——月初运行生成上月小结，避开月末日期漂移
  const target = previousMonth(currentMonth(now));

  const existing = latestForMonth(db, target);
  if (existing && now.getTime() - existing.createdAt <= INSIGHT_DEDUPE_WINDOW_MS) {
    return {
      generated: 0,
      reused: existing.id,
      skippedReason: 'dedupe',
      llmAttempted: false,
    };
  }

  return runInsightCore(db, target, 'auto');
}

/** 手动触发：检查配额后产一条（设计文档：同月二次返回 200 复用已有 payload） */
export function ensureManualInsight(
  db: Database.Database,
  now: Date,
  month: string,
): InsightRun {
  // 同月份二次手动触发 → 直接复用最新一条（设计文档已决策：用户体感"点了就有"）
  const existing = latestForMonth(db, month);
  if (existing && now.getTime() - existing.createdAt <= INSIGHT_DEDUPE_WINDOW_MS) {
    return {
      generated: 0,
      reused: existing.id,
      llmAttempted: false,
    };
  }

  // 配额：超过 AI_INSIGHT_MANUAL_QUOTA → 429
  if (getManualCount(db, month) >= AI_INSIGHT_MANUAL_QUOTA) {
    return { generated: 0, skippedReason: 'quota-exceeded', llmAttempted: false };
  }

  bumpManualCount(db, month);
  return runInsightCore(db, month, 'manual');
}

/**
 * 真正跑指标聚合 → 落通知 → 异步调 LLM 两阶段提交的核心。
 *
 * 第一阶段同步：写一条 payload.llmNarrative=null 的通知（保证 LLM 失败也能看到规则版）。
 * 第二阶段异步：调 LLM，成功就 UPDATE 同一行 llmNarrative；失败只 console.error。
 */
function runInsightCore(
  db: Database.Database,
  month: string,
  source: 'auto' | 'manual',
): InsightRun {
  const metrics = computeMonthMetrics(db, month);
  if (metrics === null) {
    return { generated: 0, skippedReason: 'no-data', llmAttempted: false };
  }
  const { summary, sections } = renderRuleNarrative(metrics);

  const model = pickDefaultModel(db);
  const payload: AiInsightPayload = {
    kind: 'monthly',
    month,
    summary,
    sections,
    llmNarrative: null,
    source,
    generatedAt: Date.now(),
    ...(model?.id != null ? { modelId: model.id as number } : {}),
  };

  const { id: notifId } = createInsightNotification(db, month, payload);

  // 未配模型时只产规则版——遵守"本地默认关闭"承诺。
  if (model === null) {
    return {
      generated: 1,
      notificationId: notifId,
      month,
      llmAttempted: false,
      skippedReason: 'no-model',
    };
  }

  // 第二阶段：异步 UPDATE LLM narrative。失败保留规则版，不抛、不删通知。
  void (async () => {
    try {
      const narrative = await llmRenderInsight(model, { metrics, ruleNarrative: summary });
      updateInsightNarrative(db, notifId, narrative);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[ai-insights] llm render failed (notification ${notifId}):`,
        describeAiInsightError(err),
      );
    }
  })();

  return { generated: 1, notificationId: notifId, month, llmAttempted: true };
}

/**
 * 启动调度：立刻跑一次 + 每 24h 一次 + unref() + 单次抛错只 log。
 * 与 startYieldReminderScheduler 同构；YAGNI：scheduler 不暴露"周期/超时"参数。
 */
export function startAiInsightScheduler(
  db: Database.Database,
  intervalMs: number = AI_INSIGHT_INTERVAL_MS,
): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const run = ensureMonthlyInsight(db, new Date());
      if (run.generated) {
        // eslint-disable-next-line no-console
        console.log(
          `[ai-insights] generated month=${run.month ?? '?'} id=${run.notificationId ?? '?'} llm=${run.llmAttempted}`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[ai-insights] tick failed:', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

/** 暴露给路由：当前月份（YYYY-MM） — 用于 `POST /api/ai-insights/generate?month=` 缺省 */
export function monthOfToday(now: Date = new Date()): string {
  return currentMonth(now);
}