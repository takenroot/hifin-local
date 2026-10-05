# HiFin AI 分析引擎（自动财务洞察）— 设计文档

> 目标：把现有 `/ai` 助手（手动聊天）和 `/discover`（纯规则洞察卡）背后缺失的
> "自动生成的财务洞察"补齐——不需要用户发问，后台按周期产出「本月消费报告 /
> 异常大额 / 分类环比异动 / 预算预警」，结果落到通知中心复用现有 30s 轮询机制。
>
> 哲学：复用一切已有的——aggregate.ts 的财务概况、yields/reminder.ts 的
> 「立刻 + 24h + 幂等」调度模式、notifications/store.ts 的写通道、app/notifications
> 的轮询+Modal 渲染。新增的 LLM 客户端必须独立可测，且与现在的 ai-assistant
> client 隔离（数据契约不同——前者喂纯文本快照+问题，后者喂结构化指标+指令）。

---

## 一、现状盘点（基于真实源码引用）

### 1.1 已经存在的"洞察"全貌

| 位置 | 做什么 | 形态 |
|---|---|---|
| `app/src/features/ai-assistant/AssistantPage.tsx:69-503` | 手动聊天页 | 用户输入问题 → 拼 system prompt → 调 LLM |
| `app/src/features/ai-assistant/aggregate.ts:116-159` | 财务概况 JSON + 纯文本序列化 | 净资产 / 月收月支 / TOP5 分类 / 目标进度 |
| `app/src/features/ai-assistant/client.ts:136-225` | OpenAI 兼容端点调用（POST `{endpoint}/chat/completions`、非流式、Bearer auth） | `chat(model, snapshot, history, input)` + `ping(model)` |
| `app/src/features/ai-assistant/storage.ts:63-106` | kv 表读写会话/默认模型 id | `loadConversation` / `setDefaultModelId` |
| `app/src/features/discover/DiscoverPage.tsx:43-271` + `insights.ts:11-147` | **纯规则洞察卡**（本月支出/储蓄率/连续记账/单笔最大支出/分类 TOP/预算提醒/目标到期/财务小贴士） | 全部纯函数，无 LLM |
| `app/src/features/notifications/NotificationCenter.tsx:121-134` | 全局每 30s 轮询 `/api/notifications?status=pending`，按 type 分流渲染（Modal 弹窗 / Toast 播报） | "锦上添花"语义：轮询失败静默吞掉 |

### 1.2 可复用模块的接口契约

- **数据库 schema（`core/src/db/schema.ts:96-145`）**
  - `aiModels(id, name, model, endpoint, apiKey)` —— 全局配置，无 spaceId；默认列表 `?hideApiKey=1`（脱敏），编辑用 `?hideApiKey=0`（明文回填，`routes/ai-models.ts:33-51`）。
  - `notifications(id, type, title, message, bill_uid, platform, status, retry_count, createdAt, updatedAt, payload TEXT)` —— `payload` JSON 文本，`parseNotificationPayload` 脏数据返回 `null`（`notifications/store.ts:102-115`）。`status` 含 `expired`，专门为"窗口过期"终态设计。
  - `kv(key, value TEXT JSON)` —— upsert PUT，`GET` 404 表示不存在，`ai.assistant.*` 系列已使用。
- **通知 store（`core/src/notifications/store.ts:149-251`）**：`createNotification(db, input)` 自动维护 `updatedAt` + 默认 `status='pending'`、`retry_count=0`；`resolveNotification` / `dismissNotification` / `expireNotification` 都是终态语义明确；`listNotifications(db, {type, status, limit})` 排序 `createdAt DESC, id DESC`。
- **路由接入（`core/src/server.ts:54-68`）**：`app.use('/api/notifications', notificationsRouter)`，`app.use('/api/kv', kvRouter)`，`app.use('/api/ai-models', aiModelsRouter)`。
- **调度范式（`core/src/yields/reminder.ts:181-227`）**：纯函数 `ensureYieldReminders(db, now)` —— 入参时间全注入；包在 `db.transaction()` 里整段幂等；返回 `{created, resolved, expired, missing}` 供日志/测试断言。**server.ts:113-136 的 `startYieldReminderScheduler`** 立刻跑一次 + 24h `setInterval` + `timer.unref?.()` 不吊进程 + try/catch 单次抛错只 log。
- **纯规则聚合（`app/src/features/discover/insights.ts:11-147`）**：`sumByType` / `monthOverMonth` / `largestExpense` / `topCategories` / `streakDays` / `budgetAlerts(threshold=90)` / `upcomingGoals(withinDays=30)` 全部纯函数，便于单测。
- **summary 路由（`core/src/routes/summary.ts:74-117`）**：已经返回 `{netAsset, monthIncome, monthExpense, monthNet, mom:{delta,deltaPct,previousMonth}}`——这部分洞察可白嫖。
- **预算路由（`core/src/routes/budgets.ts:28-45`）**：GET 全列表（可按 spaceId 过滤）；预算用量需要在 core 侧聚合（前端 `budgetAlerts` 是拉全表内存算，DB 841 笔勉强 OK，但 N 增长后浪费）。

### 1.3 现存约束（决定设计边界）

- **AI 默认关闭**——`AssistantPage.tsx:302-335` 的"未配置引导"与 `AiSection.tsx:103-116` 的"本地版本默认关闭"承诺了"未配模型绝不主动发起调用"。**自动洞察必须延续这一承诺**——未配模型时只产规则版结果，不静默弹窗。
- **prompt 大小**——aggregate.ts 的 `snapshotToText` 序列化约 20~40 行纯文本（841 笔交易时）。LLM prompt 必须**只喂聚合指标，不喂原始交易明细**（详见§3.3 成本控制）。
- **轮询成本**——前端已经每 30s 拉 `/api/notifications?status=pending`（`NotificationCenter.tsx:121-134`）。我们复用这条管道就够了，不新增 SSE / WebSocket。
- **CLI 入口**——`core/src/cli.ts:96-116` 的 `program.command('serve')` 与 `import('./server.js')` 模式是 server 启动接线点。
- **测试范式**——`core/tests/yield-reminder-e2e.test.ts:44-67` 的"openDatabase(':memory:') + migrate + setActiveDb + createApp({skipBootstrap:true}) + app.listen(0)"是单测起 server 的标准模板，照搬即可。

---

## 二、方案对比与决策

### 2.1 放 core 还是 app？

| 候选 | 优点 | 缺点 |
|---|---|---|
| **A. core（推荐）** | 调度器/聚合器可直接复用 `getDb()`、`createNotification`、`aiModels` 的纯 SQL；不依赖前端在不在；CLI 可单独触发；LLM 调用与现有 ai-assistant 完全分离（不同契约） | core 多了一个长跑定时器（已存在先例 `startYieldReminderScheduler`） |
| B. app（前端） | 复用现有 ai-assistant/client 的 `chat()` | 浏览器关了就没法跑；需要把 LLM 密钥从 kv 拿出来前端持有（安全倒退）；多用户/多空间切换麻烦 |

→ **选 A**。调度在服务端跑才"自动"。理由与 `startYieldReminderScheduler` 完全同构——都属于"用户不会主动触发但常常忘记"的事件型提醒，调度即收益。

### 2.2 存哪里：notifications vs kv vs 新表

| 候选 | 优点 | 缺点 |
|---|---|---|
| **A. 复用 `notifications` 表 + 新 `type='ai-insight'`（推荐）** | 需 v5 迁移重建表（见下）；前端轮询 / 渲染 / resolve / dismiss 全套机制直接复用 | 复用 `bill_uid` 等账单专属列语义有点错位，但 payload JSON 足够装"洞察数据" |

> **⚠️ schema.ts:134 的硬事实**：`notifications.type` 在 SQLite 层有
> `CHECK(type IN ('need_password','password_error','import_success','import_failed','yield-reminder'))`，
> CHECK 烘在既有 DB 文件的建表语句里，**只改 TS union 会在 INSERT 时被拒**。
> **必须做 v5 迁移**：按 `migrate.ts:91-156` v2→v3 的既有先例（当时为放开
> 'yield-reminder' 重建过同一张表），读 sqlite_master 判断 + RENAME + 重建 +
> INSERT SELECT，把 CHECK 扩入 `'ai-insight'`。幂等性同样来自读 sqlite_master 而非
> user_version。`store.ts` 的 `assertType` 白名单同步追加。
| B. 新 `aiInsights` 表 | 字段语义干净，可加 `priority` / `category` 等列 | 多一个表 + 一套 CRUD + 前端多一个轮询端点；迁移成本与"复用现有模式"哲学相悖 |
| C. 存 `kv: ai.insights.lastGeneratedAt` | 极简 | 完全没有历史记录、不能 dismiss/resolve、不能从前端列表查 |

→ **选 A**。加一个 `type='ai-insight'` enum 值即可，所有读写全部走现有 `createNotification` / `listNotifications` / `resolveNotification`。`payload` 装 `{ kind, month, summary, sections[], modelId, generatedAt }`。

### 2.3 LLM 调用策略：何时调、降级路径、token 控制

| 候选 | 优点 | 缺点 |
|---|---|---|
| **A. 规则版 always-on + LLM 加成按需（推荐）** | 任何时候都有可用结果；未配模型时仍有价值（纯规则版） | 实现两套"洞察生成器" |
| B. 必须 LLM，未配就跳过本月 | 简单 | 用户空跑一个月，承诺违约 |
| C. 必须 LLM，未配就报错 | 同上 + 难用 | 同上 + 难用 |

→ **选 A**。规则版 + LLM 加成两者并存，每条 insight 是一段"模板 + 数值"——LLM 拿到的 prompt 只描述数据（结构化 key/value），自己决定要不要润色成自然语言。**降级路径就是规则版本身**，不需要单独的 fallback 分支。

- **prompt token 控制**：喂的是"已经聚合好的指标"——`{monthIncome, monthExpense, monthNet, mom.delta, topCategories: [{name, amount, pct}], budgetAlerts: [{name, spent, pct}], anomalyLarge: [{date, name, amount}]}`。**原始交易明细不进 prompt**（841 笔已经在 insights.ts 里聚合成 TOP3/单笔最大，进 prompt 的"指标"只有 10~30 行 JSON）。单次 prompt 输入估算 1k~2k tokens，输出 200~500 tokens。
- **模型选择**：读 `aiModels` 表 `ORDER BY id ASC LIMIT 1`，再用 `kv:'ai.defaultModelId'` 覆盖（如果设过）。**完全沿用** `AssistantPage.tsx:90-105` 与 `AiSection.tsx:60-72` 的"默认 id"语义——用户已经在 `AiSection` 设过的就是他想用的。
- **失败处理**：单次 LLM 调用失败（401/429/5xx/network）→ `console.error` + 不写通知；本月规则版仍产。**不重试**——每月本来就只跑一次，重试交给下个月。

### 2.4 调度策略：何时跑、跑几次

| 候选 | 优点 | 缺点 |
|---|---|---|
| **A. 月初 1 号 9:00 跑一次（推荐）** | 自然语义"月度报告"；token 成本可控；与 1 月催填同窗口可合并调度 | 跑点固定 → 用户在那段时间没开 server 就漏；`startYieldReminderScheduler` 早就用 "立刻 + 周期" 解决了 |
| B. 每天跑 + 去重 | 永远不会漏 | token 成本爆炸；冗余 |
| C. 用户进入 `/discover` 时拉 | 无调度成本 | 用户不开页面就没洞察 |

→ **选 A + "立刻 + 24h 周期 + 幂等"模式**。理由与 `startYieldReminderScheduler` 完全一致（注释 `server.ts:106-108` 解释过）。**去重**：同月份（YYYY-MM）已有 pending / resolved 的 insight 时跳过——这是幂等的边界。

- **手动触发**：`POST /api/ai-insights/generate?month=YYYY-MM` —— 复用 `summarizeMonth` 纯函数，扣 1 次手动额度（见§2.5），不写入"自动生成"的字段（`source: 'manual'`）。

### 2.5 成本与防滥用

- **每月自动 1 条 + 手动 N 条上限**（N=3，存 `kv:'ai.insights.manualQuota'` 或临时跑不持久化）。
- **单次 LLM 调用上限**：temperature=0.4、`max_tokens=600`、超时 30s。失败立即放弃，不重试。
- **不缓存 LLM 结果**（每月天然唯一），但**缓存规则版结果**（同 month 跑 N 次结果一致——纯函数 + 同 db，N=1 时不缓存，N>1 时直接复用 `listNotifications(db, {type:'ai-insight', status:'resolved'})` 查最近同月那条的 payload）。

### 2.6 前端展示位：扩展通知中心 + Dashboard 角标

| 候选 | 优点 | 缺点 |
|---|---|---|
| **A. 复用 NotificationCenter + 角标（推荐）** | 0 新增 UI 模块；用户已有"红点"心智模型 | NotificationCenter 现在只渲染账单类；需要小幅扩展 Modal 渲染分支 |
| B. 在 `/discover` 顶部插一块"AI 报告"区 | 与 Discover 主题一致 | 与"自动通知"语义错位；需要新增轮询 |
| C. 新建 `/insights` 页 | 入口清楚 | 多一个页面 + 多一个轮询 |

→ **选 A**。NotificationCenter 的 type 分流已有 `pickModalNotification` / `pickToastNotifications` 抽象（`notifications/logic.ts`），加一个分支即可。**Dashboard 顶角加一个"AI 报告待查看"小红点**——复用现有 `useApi` 的 `/api/notifications?status=pending&type=ai-insight` 即可，**不动 Dashboard 现有结构**。

---

## 三、详细方案

### 3.1 数据契约

**新增 notification type**：

```ts
// core/src/db/schema.ts:208-217  NotificationType union 追加
| 'ai-insight'
```

**payload schema**（`payload` 列 JSON 文本，遵循 `parseNotificationPayload` 已有约定）：

```ts
interface AiInsightPayload {
  kind: 'monthly' | 'anomaly' | 'budget' | 'category-mom';
  /** 目标月份，YYYY-MM；anomaly 类不填（实时触发） */
  month?: string;
  /** 规则版摘要（永远存在），用于 LLM 失败时直接渲染 */
  summary: string;
  /** 结构化小节，每节 {title, metric, tone} —— metric 是 key/value 数组，tone 是 'neutral'|'good'|'warning'|'danger' */
  sections: Array<{
    title: string;
    metric: Array<{ key: string; value: string }>;
    tone: 'neutral' | 'good' | 'warning' | 'danger';
  }>;
  /** LLM 润色后的中文段落；失败/未调时为 null，UI 退化为 summary 拼接 */
  llmNarrative: string | null;
  /** 触发来源：自动调度 = 'auto'，手动 = 'manual' */
  source: 'auto' | 'manual';
  /** LLM 模型 id（auto 调用过 LLM 时填） */
  modelId?: number;
  generatedAt: number;
}
```

**为何不用新表**：notifications 已经支持 status 终态、resolve/dismiss、按 type 过滤、payload JSON——所有需求都满足。新表会引入一整套 CRUD 与迁移，得不偿失。

### 3.2 调度器（`core/src/insights/scheduler.ts`）

完全模仿 `core/src/yields/reminder.ts` 的写法，注释解释"为什么这么做"。

```ts
// core/src/insights/scheduler.ts (设计稿，非源码)
import type Database from 'better-sqlite3';
import { createNotification, listNotifications } from '../notifications/store.js';

export const AI_INSIGHT_TYPE = 'ai-insight';

/** 距离上条同 month 的 ai-insight 多少 ms 才允许再次生成（同月去重） */
export const INSIGHT_DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** 目标月份：now 所在月；"月度报告"本月月初可生成；上个月只能回溯 1 个月 */
export function insightTargetMonth(now: Date): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

/** 该月份最近一条 ai-insight 通知（任意 status） */
export function latestForMonth(db: Database.Database, month: string): NotificationRow | null {
  // payload JSON LIKE '%"month":"2026-01"%' — 故意走 LIKE 而非 JSON 函数，
  // 因为 SQLite JSON 函数在不同时编译期版本下行为有差异
}

/** 自动调度：每月第一次跑时生成"上一个月"的报告，避免月末日期漂移 */
export function shouldGenerate(db: Database.Database, now: Date): boolean {
  const target = previousMonth(insightTargetMonth(now));
  const prev = latestForMonth(db, target);
  if (!prev) return true;
  // 同月份已有且未超过去重窗口 → 跳过
  return now.getTime() - prev.createdAt > INSIGHT_DEDUPE_WINDOW_MS;
}

/** 自动周期：与 yields 同 24h，但只在每月 1 号前 7 天窗口内真正干活 */
export function ensureMonthlyInsight(db: Database.Database, now: Date): {
  generated: 0 | 1;
  skippedReason?: 'dedupe' | 'no-model' | 'no-data';
} {
  if (!shouldGenerate(db, now)) return { generated: 0, skippedReason: 'dedupe' };
  // 检查 aiModels 是否有可用模型
  const model = pickDefaultModel(db);
  if (!model) return { generated: 0, skippedReason: 'no-model' };
  // 跑核心
  const payload = buildAndRenderInsight(db, model, previousMonth(...), now);
  createNotification(db, { type: AI_INSIGHT_TYPE, title, message, payload });
  return { generated: 1 };
}
```

**核心函数 `buildAndRenderInsight(db, model, month, now)`**：

1. 调 `computeMonthMetrics(db, month)` 拿结构化指标（见§3.3）。
2. 调 `renderRuleNarrative(metrics)` 拿规则版中文摘要（与 `discover/insights.ts` 风格一致）。
3. **同步** 写一条 payload.llmNarrative=null 的通知 → 这是"保险"——LLM 失败用户也能看到。
4. **异步** 调 `llmRender(model, metrics, ruleNarrative)` → 成功就 UPDATE 同一行 payload.llmNarrative（新增的 store 函数见§3.4）。
5. UPDATE 失败/超时：log + 保留规则版，**不删原通知**。

```ts
// server.ts:113-136 模式照搬
export function startAiInsightScheduler(db, intervalMs = 24*60*60*1000): NodeJS.Timeout {
  const tick = () => {
    try {
      const run = ensureMonthlyInsight(db, new Date());
      if (run.generated) console.log(`[ai-insights] generated ${target}`);
    } catch (err) {
      console.error('[ai-insights] tick failed:', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}
```

### 3.3 数据源 SQL（纯函数 `computeMonthMetrics`）

**不重复造 SQL**：直接复用 `discover/insights.ts` 的纯函数，把输入从「前端 REST 拉来的数组」换成「core 直接查 db 的数组」，函数体一字不改。

```ts
// core/src/insights/metrics.ts (设计稿)
import type Database from 'better-sqlite3';
import { TransactionRow, AccountRow, BudgetRow, GoalRow, CategoryRow } from '../db/schema.js';
import { sumByType, topCategories, budgetAlerts, monthOverMonth,
         largestExpense, upcomingGoals } from '../../../app/src/features/discover/insights.js';
// ↑ 注意：这里是跨包复用。tsx 运行时支持；vitest 也支持 ESM import .ts。
// 若不想跨包，则把 discover/insights.ts 的纯函数原样复制一份到 core/src/insights/math.ts ——
// ponytail:不重复抽象；但跨包引用 .js 走 vitest 时会有 alias 麻烦，
// 实际选择：core 内置一份精简版（150 行），保留与 app 版同样的输入/输出契约。
```

> **决策**：在 `core/src/insights/math.ts` 内置精简版（同签名、同算法），不跨包引用。
> 理由：`app/.../discover/insights.ts` 依赖 `@/db`（前端类型）；core 不能跨方向 import。
> ponytail 不反对复制——反对的是"重新设计一个不一样的版本"。这里只是搬家。
>
> **⚠️ 移植时去掉 dayjs**：`core/package.json` 无 dayjs 依赖（app 侧才有），
> `upcomingGoals` / `streakDays` 里的 dayjs 调用改为原生 Date 运算（按天取整
> `Math.floor(t/86400000)` 即可），签名随之微调（`now: number` 时间戳入参）。

```ts
// core/src/insights/metrics.ts (设计稿)
export interface MonthMetrics {
  month: string;            // YYYY-MM
  income: number;
  expense: number;
  net: number;
  momPct: number | null;    // 净收支环比
  topExpense: CategoryRank[];     // topCategories
  topExpenseMom: Array<{categoryId:number; name:string; this:number; prev:number; deltaPct:number | null}>; // 分类环比
  largest: { name: string; amount: number; date: number } | null; // largestExpense
  budgetAlerts: BudgetAlert[];     // budgetAlerts(threshold=80)
  goalsNear: Goal[];                // upcomingGoals(withinDays=30)
  anomalyLarge: Array<{ name: string; amount: number; date: number; ratioToAvg: number }>; // 单笔 > 月均*5 触发
}

export function computeMonthMetrics(db: Database.Database, month: string): MonthMetrics {
  const range = monthRange(month);   // 复用 core/src/routes/summary.ts:24-35 的 monthRange
  const prevRange = monthRange(previousMonth(month));
  const accounts = db.prepare('SELECT * FROM accounts WHERE spaceId = 1').all() as AccountRow[];
  // ↑ spaceId 默认 1；多空间 v2 再加参数
  const txs = db.prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?').all(range.start, range.end) as TransactionRow[];
  const prevTxs = db.prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?').all(prevRange.start, prevRange.end) as TransactionRow[];
  const budgets = db.prepare('SELECT * FROM budgets').all() as BudgetRow[];
  const goals = db.prepare('SELECT * FROM goals').all() as GoalRow[];
  const categories = db.prepare('SELECT * FROM categories').all() as CategoryRow[];

  const income = sumByType(txs, 'income', range.start, range.end);
  const expense = sumByType(txs, 'expense', range.start, range.end);
  const prevExpense = sumByType(prevTxs, 'expense', prevRange.start, prevRange.end);
  const prevIncome = sumByType(prevTxs, 'income', prevRange.start, prevRange.end);

  // 分类环比：今年 vs 上年同月
  const thisByCat = groupByCategory(txs.filter(t=>t.type==='expense'));
  const prevByCat = groupByCategory(prevTxs.filter(t=>t.type==='expense'));
  const topExpenseMom = mergeTopDeltas(thisByCat, prevByCat, categories).slice(0, 5);

  // 异常大额：单笔 > 月均支出的 5 倍（与 discover 的 largestExpense 是不同口径）
  const avgPerTx = expense / Math.max(1, txs.filter(t=>t.type==='expense').length);
  const anomalyLarge = txs
    .filter(t=>t.type==='expense' && t.includeInAsset && t.amount > avgPerTx * 5)
    .sort((a,b)=>b.amount-a.amount)
    .slice(0, 5)
    .map(t => ({ name: t.name, amount: t.amount, date: t.date, ratioToAvg: t.amount / avgPerTx }));

  return {
    month, income, expense, net: income - expense,
    momPct: monthOverMonth(income - expense, prevIncome - prevExpense),
    topExpense: topCategories(txs, categories, range.start, range.end, 3),
    topExpenseMom,
    largest: largestExpense(txs),
    budgetAlerts: budgetAlerts(budgets, txs, 80, new Date(range.start)),
    goalsNear: upcomingGoals(goals, 30, dayjs(range.start)),
    anomalyLarge,
  };
}
```

### 3.4 LLM 客户端（`core/src/insights/llm.ts`）

**与 ai-assistant/client 隔离**：client 是"用户问题 + 历史"，prompt 是自然语言对话；这里是"结构化指标 + 指令"，prompt 是 JSON。

```ts
// core/src/insights/llm.ts (设计稿)
import type { AiModelRow } from '../db/schema.js';

export interface InsightPromptInput {
  metrics: MonthMetrics;           // 上面 §3.3 的结构
  ruleNarrative: string;           // 规则版中文（已渲染好，给 LLM 参考）
}

const SYSTEM_PROMPT = `你是 HiFin 的财务助手「小账」。基于下方结构化指标与规则版摘要，
用简体中文写一段不超过 200 字的月度财务点评。要求：
- 不要编造数据，只能引用指标里出现的数字
- 用平实语气，不要用 emoji 和过度修辞
- 重点指出 1) 收支异常 2) 预算/目标风险 3) 一个改进建议
- 若规则版摘要已足够清楚，原样返回"`;

export async function llmRenderInsight(
  model: AiModelRow,
  input: InsightPromptInput,
  opts: { signal?: AbortSignal; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const url = resolveUrl(model.endpoint);
  // 沿用 ai-assistant/client.ts:128-133 的 resolveUrl 逻辑（同样的 input 模型）
  const userPayload = JSON.stringify(input.metrics, null, 0);  // 1k~2k tokens
  // ...
  // 30s 超时；abort signal；错误归类（auth/network/rate_limit/server）参考
  // ai-assistant/client.ts:76-125 的 classify + describeError。
  // 失败抛 AiInsightRenderError，由 scheduler.ts 的 try/catch 接住。
}
```

### 3.5 REST 路由（`core/src/routes/ai-insights.ts`）

| Method + Path | 用途 | 行为 |
|---|---|---|
| `GET /api/ai-insights?status=pending\|resolved\|dismissed` | 前端列表 | 复用 `listNotifications(db, {type:'ai-insight', status})` |
| `GET /api/ai-insights/:id` | 单条详情 | 复用 `getNotification(db, id)` |
| `POST /api/ai-insights/:id/resolve` | 用户看完标 resolved | 复用 `resolveNotification(db, id)` |
| `POST /api/ai-insights/:id/dismiss` | 用户忽略 | 复用 `dismissNotification(db, id)` |
| `POST /api/ai-insights/generate?month=YYYY-MM` | 手动触发 | 手动配额（详见§2.5）+ `buildAndRenderInsight` |

**配额实现**——极简：每次手动请求前查 kv:`ai.insights.manualCount.YYYY-MM`（无 key 视为 0），+1 后 PUT。超过 N=3 时返回 429。**不需要新表**——kv 已经有现成模式（`mail.config` / `ai.defaultModelId` 等）。

### 3.6 前端改动（最小 diff）

| 文件 | 改动 |
|---|---|
| `app/src/features/notifications/types.ts:14-29` | `NotificationType` union 加 `'ai-insight'`；`TYPE_SET` 同步追加 |
| `app/src/features/notifications/logic.ts` | 新增 `pickModalNotification` / `pickToastNotifications` 分支：`type === 'ai-insight'` → 用 payload 渲染 |
| `app/src/features/notifications/NotificationCenter.tsx:165-180` | toast 播报分支：ai-insight 的 toast 文案用 `payload.summary` 前 60 字 |
| `app/src/features/notifications/api.ts` | 加 `fetchAiInsightDetail(id)` 用于 Modal 内详情 |
| `app/src/layout/AppLayout.tsx`（Dashboard 角标） | 加一条 `useApi('/api/notifications?status=pending&type=ai-insight')`，渲染小红点 + 链接 |

**不新增**模块、不动 `/ai` 聊天页、不动 `/discover` 数据洞察卡。**只扩展通知中心**——这是与 `pickModalNotification` / `pickToastNotifications` 现有抽象对齐的做法。

### 3.7 CLI 入口

不新增。CLI 已经是 `cli serve` 自动起 server + scheduler 整套。运维要"现在生成一条"可以直接 `curl -X POST '/api/ai-insights/generate?month=2026-01'`，**不需要 cli 子命令**——ponytail: 不为没人要的 CLI 入口写新代码。

---

## 四、改动清单（预估 diff 规模）

> "越小越好"。下面给的是上界。

| 文件 | 类型 | 行数预估 |
|---|---|---|
| `core/src/db/schema.ts` | `NotificationType` union 增 `'ai-insight'`（+1 行）；`NOTIFICATION_TYPES` 数组同步（+1）；SCHEMA_SQL 的 CHECK 扩入新类型（+1） | +3 |
| `core/src/db/migrate.ts` | **v5 迁移**：照 v2→v3 先例重建 notifications 表扩 CHECK（`SCHEMA_VERSION` 4→5 + 重建函数 + 测试） | ~60 |
| `core/src/insights/metrics.ts`（新建） | 精简版 insights math（sumByType / topCategories / budgetAlerts / monthOverMonth / largestExpense / upcomingGoals 移植）+ computeMonthMetrics + groupByCategory + mergeTopDeltas | ~180 |
| `core/src/insights/llm.ts`（新建） | `llmRenderInsight` + resolveUrl（移植自 client.ts:128-133，~10 行）+ classifyError（移植自 client.ts:76-125，~50 行）+ AiInsightRenderError | ~140 |
| `core/src/insights/scheduler.ts`（新建） | `ensureMonthlyInsight` + `shouldGenerate` + `latestForMonth` + `pickDefaultModel` + `startAiInsightScheduler` | ~120 |
| `core/src/insights/store.ts`（新建） | `updateInsightPayload(db, id, partial)` —— 单测可注入；用于"先写规则版、再更新 llmNarrative"两阶段提交 | ~30 |
| `core/src/routes/ai-insights.ts`（新建） | 5 个端点 | ~90 |
| `core/src/server.ts` | `app.use('/api/ai-insights', aiInsightsRouter)`（+1）+ `startAiInsightScheduler(getDb())`（+1） | +2 |
| `app/src/features/notifications/types.ts` | `NotificationType` 加 `'ai-insight'`（+1 行）+ `TYPE_SET`（+1） | +2 |
| `app/src/features/notifications/logic.ts` | `pickModalNotification` / `pickToastNotifications` 各加 1 个分支 | +15 |
| `app/src/features/notifications/NotificationCenter.tsx` | toast 播报分支；ai-insight 用 summary 前 60 字 | +8 |
| `app/src/features/notifications/api.ts` | `fetchAiInsightDetail(id)` | +10 |
| `app/src/layout/AppLayout.tsx` | 角标 + 链接 | +15 |

**core 单测新增**：
| 文件 | 类型 | 行数预估 |
|---|---|---|
| `core/tests/insights-metrics.test.ts` | math 函数单测（含 mom 边界、异常大额口径、空数据） | ~80 |
| `core/tests/insights-scheduler.test.ts` | 幂等（同 month 不重生）+ 无模型跳过 + 立刻 + 24h | ~70 |
| `core/tests/insights-llm.test.ts` | mock fetch 测 prompt 构造 + 超时 + 错误归类 | ~60 |
| `core/tests/insights-route.test.ts` | e2e：generate → list → resolve；手动配额 | ~70 |

**总 diff 规模**：核心 ~630 行（含 v5 迁移）+ 测试 ~280 行 = **~910 行新增**。比"新表 + 新 CRUD + 新轮询 + 新页面"省一半。

---

## 五、测试与验收计划

### 5.1 单元测试（`core/tests/insights-*.test.ts`，vitest）

1. **math 函数**（`insights-metrics.test.ts`）
   - `sumByType` 包含/排除 `includeInAsset=0` 与 `type=transfer` 的边界
   - `topCategories` 当 `total=0` 返回 `[]`，而不是除零
   - `monthOverMonth` 上期为 0 返回 `null`
   - `computeMonthMetrics` 用 841 笔真实 fixture（可从现有 `core/data/hifin.db` 抽 1 个月子集固化），断言字段数与口径
   - `anomalyLarge` 阈值 = 月均 * 5 的口径验证（拿单笔最大 vs 月均）
2. **scheduler 幂等**（`insights-scheduler.test.ts`）
   - 同月份跑两次：第二次 `generated=0`，不增加 notification 数
   - 7 天后再跑：仍跳过（INSIGHT_DEDUPE_WINDOW_MS）
   - 无 aiModels 时：`skippedReason='no-model'`
   - 上一月份有 resolved 通知：当月仍可生成（**不**复用旧 payload）
3. **LLM mock**（`insights-llm.test.ts`）
   - `fetch` 注入：mock server 验证 `messages` 数组形态（system + user only）
   - 验证 system prompt 包含 SYSTEM_PROMPT 字面量、user content 是合法 JSON
   - 超时（30s 不响应）：抛 `AiInsightRenderError`，scheduler 不重试
   - HTTP 401 → `kind:'auth'`；429 → `kind:'rate_limit'`；5xx → `kind:'server'`（错误归类与 `ai-assistant/client.ts:76-106` 对齐）
4. **REST 路由**（`insights-route.test.ts`）—— 用 `tests/yield-reminder-e2e.test.ts:44-67` 同样的 `:memory:` 模板
   - `POST /api/ai-insights/generate?month=2026-01` → 200，返回 `{id, payload}`
   - 同月第二次（< 7 天）→ 409 或 200 with reused？**待 §六开放问题 1 决策**；倾向 200 + 复用（避免用户阻塞）
   - `GET /api/ai-insights/:id` → 200
   - `POST /api/ai-insights/:id/resolve` → 200 + status='resolved'
   - 手动配额超出 → 429

### 5.2 端到端验收（Playwright，`accept/scripts/ai-insights-smoke.mjs`）

- 启动 core + dev server，写入 fixture（1 个月交易 + 1 个 aiModels + 1 个 budget）
- 触发 `POST /api/ai-insights/generate?month=2026-01`
- 30s 内等前端轮询拉到通知，截图通知中心 Modal 的渲染
- dismiss 后断言 `/api/notifications?status=pending&type=ai-insight` 为空

### 5.3 不在测试覆盖范围

- LLM 实际响应内容（只 mock，**不**做端到端真模型测试）——成本 + 不稳定。
- 调度器"立刻 + 24h"周期计时——只测 `tick()` 同步逻辑，**不**测 `setInterval` 真实间隔。

---

## 六、风险与开放问题

### 6.1 风险

1. **LLM 调用卡死**：30s 超时仅是 `AbortController.signal`，better-sqlite3 同步写入不会被中断。**缓解**：异步 UPDATE 失败时只 log，不抛、不影响主通知。
2. **payload 越来越大**：AI 返回的 narrative 可能很长。**缓解**：`max_tokens=600` 硬限；`summary` 兜底时也限 200 字。
3. **同月份 manual + auto 双生成**：手动配额 N=3 用尽后用户仍可能想"再生成一遍"。**缓解**：手动返回 429 时提示 "本月已生成 3 次，下个月 1 号自动续"（与 auto 周期对齐，用户不会觉得被拒）。
4. **多空间**：当前设计只查 `spaceId=1`。**待办**：v2 加 `?spaceId=` 参数；多空间用户先看到空间 1 的洞察（最常见），避免一开始就过度设计。

### 6.2 开放问题

1. **同月份二次手动触发的语义**：返回 200 复用旧 payload？还是 409 拒绝？倾向 200 + 复用（用户体感"我点了就有"），但需 dev 决策。
2. **AI narrative 是否进 SQLite**：进 `payload.llmNarrative` 字段意味着每次都要反序列化整段 JSON 给前端。**倾向进**——前端不用单独 LLM 渲染，且 SQL LIKE 仍能搜 summary 关键字。
3. **`/discover` 是否同步显示 AI 报告**：现在 `/discover` 是纯规则卡，AI 报告只在通知中心出现。**倾向不在 Discover 重复**——避免双通道给用户造成"我在哪儿能看到"的困惑；Dashboard 角标 + 通知中心 Modal 已足够。
4. **提示默认模型 vs 用户主动选**：ai-assistant 现在用 `getDefaultModelId()` (`AssistantPage.tsx:90-105`)。**沿用**——不引入新模型选择 UI，避免设计扩散。
5. **测试时如何 mock `now`**：`yields/reminder.ts` 全部时间从入参注入（注释 `yields/reminder.ts:16-18`），本设计照抄——所有函数 `now: Date` 必填入参；scheduler 那一层才 `new Date()`。
6. **dashboard 角标的视觉一致性**：与现有"通知小红点"视觉冲突？**待 design review**——属于设计问题，不是技术问题。先做"路由 + 数据"骨架，UI 在 dev 时讨论。

---

## 七、与项目哲学的自检

- **最小 diff**：核心增量 ~570 行，比"新表 + 新模块 + 新页面"省一半。✅
- **复用现有 helper**：`discover/insights.ts` 的纯函数整段搬运到 `core/src/insights/math.ts`（不抽象、不改算法，只搬家）。`notifications/store.ts` / `summary.ts` 的 monthRange / yields/reminder.ts 的调度器模式全部复用。✅
- **YAGNI**：不抽象多空间、不做 WebSocket 推送、不引入 SSE、不新增调度框架。✅
- **不新增依赖**：LLM 客户端用 node 自带 `fetch`（core Node24+ 已具备）；不引 openai SDK。✅
- **删除优于新增**：不删任何文件；只在既有 union / 数组里加 1 个字符串。✅

---

## 附：核心代码交叉引用清单

- 调度模式：`core/src/yields/reminder.ts:181-227` + `core/src/server.ts:113-136`
- 通知读写：`core/src/notifications/store.ts:149-251`
- 路由接入：`core/src/server.ts:54-68`
- 财务聚合：`core/src/routes/summary.ts:74-117`
- 纯规则洞察：`app/src/features/discover/insights.ts:11-147`
- LLM 调用契约：`app/src/features/ai-assistant/client.ts:136-225`
- 模型读取：`app/src/features/ai-assistant/AssistantPage.tsx:90-105`
- 前端通知中心：`app/src/features/notifications/NotificationCenter.tsx:121-134`
- 单测范式：`core/tests/yield-reminder-e2e.test.ts:44-67`
