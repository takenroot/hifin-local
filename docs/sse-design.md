# HiFin SSE 实时通知设计

> 立项动机（见 `CHANGELOG.md` 2026-10-05 路线图）：把"账单导入完成 / need_password 弹窗"
> 这类事件的端到端延迟从最长 30s（前端轮询）压到秒级。
>
> 本设计文档是**纯调研成果**，不改任何源码/配置；具体落地见"改动清单"一节，
> 实施时按"YAGNI→复用既有 helper→最小 diff"的顺序走。

---

## 一、现状盘点（引用源码）

### 1.1 通知数据流（端到端）

```text
核心写入点（同步 createNotification / resolveNotification / expireNotification）
    │
    ▼
SQLite (notifications 表，schema.ts:132-144)
    │
    ▼ 30s 一次 GET /api/notifications?status=pending
    │
前端 NotificationCenter（30s setInterval，NotificationCenter.tsx:124）
    │
    ├──→ pickModalNotification → 弹 Modal 索要密码
    └──→ pickToastNotifications → 右上角 toast 播报
```

**写入路径（5 个）**，全部走 `createNotification(db, input)`（`core/src/notifications/store.ts:149`）：

| 触发场景 | 调用点 | 行号 |
| --- | --- | --- |
| IMAP 收到账单邮件但内存无密码 | `mail/poller.ts` 无密码分支 | `core/src/mail/poller.ts:837` |
| 账单导入成功 | `mail/poller.ts` 解压成功分支 | `core/src/mail/poller.ts:870` |
| 账单导入失败 | `mail/poller.ts` 异常分支（`password_error`） | `core/src/mail/poller.ts:901` |
| 1 月催填：缺年度收益记录 | `yields/reminder.ts` ensureYieldReminders | `core/src/yields/reminder.ts:200` |
| 2 月起仍 pending：标记 expired | `yields/reminder.ts` 同函数 | `core/src/yields/reminder.ts:221` |

**resolve / dismiss 入口**（用户侧）：
- `POST /api/notifications/:id/resolve` → `core/src/routes/notifications.ts:85-99`
- `POST /api/notifications/:id/dismiss` → `core/src/routes/notifications.ts:102-116`

**前端消费路径**：
- 路由适配层：`app/src/features/notifications/api.ts:14` — `fetchPendingNotifications(signal?: AbortSignal)` 已支持 abort
- 组件：`app/src/features/notifications/NotificationCenter.tsx`
  - 唯一业务轮询：`useEffect` 里 `window.setInterval(..., POLL_INTERVAL_MS)`，`NotificationCenter.tsx:124`
  - 第二个 `setInterval`：`NotificationCenter.tsx:184`，每 1s 清扫过期 toast——**与通知无关**，保留即可
- 挂载点：`app/src/layout/AppLayout.tsx:235`（全局单实例）

### 1.2 store 的写入契约

`createNotification`（`core/src/notifications/store.ts:149-174`）：

- 入参：`(db, CreateNotificationInput)`
- 行为：落 SQLite、返回完整 `NotificationRow`（含自增 `id`、默认 `status='pending'`、`retry_count=0`、默认 `createdAt=updatedAt=Date.now()`）
- 是**同步**函数（`better-sqlite3` 同步 API），执行结束就是 DB 已写入 + 索引可见
- 校验：`assertType` / `assertStatus` / `assertId`（`store.ts:124/117/80`），失败直接抛 `Error`

→ **关键结论**：写入点全在同进程同步执行，事件发布**完全可以在 store 层钩住**而无需任何轮询差集。

### 1.3 前端的轮询与 SWR 交互

`app/src/hooks/useApi.ts:57-99`：
- 模块级 `Map<url, unknown>` SWR 缓存
- `loading` 语义是"还没东西可展示"，有缓存命中时首帧直接 false
- **后台失败保留陈旧数据**：`.catch` 里若 `prev.data !== null` 就保留旧值、只置 `error`（`useApi.ts:84-91`）
- `refetch()` 强制拉新并回写缓存

`NotificationCenter` 并不直接用 `useApi`，而是手写 `poll()`（`NotificationCenter.tsx:108-116`）+ `setInterval`：
- 失败时静默吞掉，保留本地 `notifications` 旧值（`NotificationCenter.tsx:112-115` 的 `poll()` 内部已有相同语义）
- `processingId` 期间暂停轮询、只等 +30s 一次（`NotificationCenter.tsx:125-128`）

→ **关键结论**：前端对"延迟一次再拉" / "失败保留旧值" 这两条语义都已经建模过。SSE 替换轮询时，**只需把"通知事件"当成增量的"refetch 触发器"**，不要动 SWR 缓存层。

### 1.4 need_password 弹窗链路（轮询驱动）

```
store.createNotification('need_password')      [poller 写入]
        │
        ▼  ≤30s 延迟
前端 poll() → setNotifications(list)
        │
        ▼
useEffect（[notifications]）：pickModalNotification → setActiveId
        │
        ▼
<Modal open> → 用户输入密码 → POST /api/bills/:uid/password
        │
        ▼
poller 下轮轮询：try unzip → 成功 → store.createNotification('import_success') + resolveNotification(prevId)
        │
        ▼
前端 poll 拉到：prevId 已从 pending 消失 → useEffect 把 activeId=null、pushToast('success', ...)
```

**这条链路在 SSE 下要保持不变**：用户点"提交"后**不再**依赖前端 30s 轮询来探测后端解压结果，改为监听 SSE 事件即可；但**已有的 `scheduleImportCheck`（30s 后兜底拉一次）保留**——单条 SSE 丢了不影响（见 §4.3 降级策略）。

### 1.5 Vite dev proxy 与 SSE

`app/vite.config.ts:14-18`：

```ts
proxy: {
  '/api': {
    target: 'http://localhost:8787',
    changeOrigin: true,
  },
},
```

- vite 走 `http-proxy`（1.x / 3.x），对 chunked / streaming 响应**默认**不缓冲：它把上游原样管道到下游；但 SSE 仍有两个隐患：
  1. **首次响应头未 flush**：`res.writeHead` + `res.write` 不调 `res.flushHeaders()` 时，Node 默认会缓冲到 ~16KB 或到第一段 `\n\n` 才发出。SSE 每条事件以 `\n\n` 结束，正好满足 flush 触发，但**心跳注释行 `:keepalive\n\n`** 必须保留才能撑住代理超时
  2. **代理/浏览器超时**：dev proxy 一般不设超时，但 nginx / 云反代常见 60s 无数据断开。心跳注释 `:` 是反代通行的存活信号
- `changeOrigin: true` 仅改 `Host` 头，与 SSE 无关

→ **结论**：方案必须包含 (a) 路由层 `res.flushHeaders()`、(b) 周期性心跳注释行（推荐 25s，避开常见 30s/60s 超时阈值）。

### 1.6 SQLite WAL 与并发

- `core/src/db/connection.ts:38-39`：`journal_mode = WAL` + `foreign_keys = ON`
- SSE 端点是**只读**（不发 SQL），写入仍是同步 `createNotification`，没有引入新的并发路径
- better-sqlite3 同一进程单连接，单写者天然满足
- → SSE **不影响** DB 写竞争

### 1.7 测试与验收现状

- core 测试：`core/tests/notifications.test.ts` 已有 store + REST 完整覆盖（403 行）
- app 测试：Vitest 50 例（`CHANGELOG.md:39`），`app/tests/setup.ts` 已无 fake-indexeddb，环境是 `node`（`app/vitest.config.ts:8`）
- 验收：`accept/scripts/*.mjs` 是 Playwright 脚本，运行在 5187 端口（见 `dexie-purge-smoke.mjs:14`）

---

## 二、方案设计

### 2.1 总体目标

- 单源：新增 `GET /api/notifications/stream`，保持 `GET /api/notifications` 现有 4 条接口不变（`GET /`、`GET /:id`、`POST /:id/resolve`、`POST /:id/dismiss`）
- 实时：后端在 `createNotification` 落库后**同步**向所有订阅者推送；前端 EventSource 接到事件后触发一次内存 refetch
- 降级：EventSource 失败 / 浏览器不支持时**透明**回退 30s 轮询；多标签页各自连接 / 共享均可接受
- 写不动既有 5 条 REST、15 条其它路由、轮询组件之外的任何模块

### 2.2 后端：SSE 路由 + 事件总线

#### 2.2.1 新增文件：`core/src/notifications/bus.ts`

**职责**：进程内的订阅-广播机制。**最小实现**，不引入 EventEmitter 之外的任何依赖。

```ts
// 形状契约（伪代码，实际用 TS 严格类型写）
type NotificationEvent =
  | { kind: 'created'; notification: NotificationRow }
  | { kind: 'resolved'; id: number }
  | { kind: 'dismissed'; id: number }
  | { kind: 'expired'; id: number };

type Subscriber = (ev: NotificationEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function publish(ev: NotificationEvent): void {
  for (const fn of subscribers) {
    try { fn(ev); } catch { /* 单个订阅者抛错不影响其它 */ }
  }
}
```

> **YAGNI**：不上 `EventEmitter`、不区分 topic、不做背压。订阅者是本地 SSE response，
> 抛错 = 客户端已断，留个 try/catch 即可。

#### 2.2.2 钩入 store：`core/src/notifications/store.ts`

**最小侵入**：在 5 个写入函数末尾加一行 `publish(...)`：

| 函数 | 末尾加 |
| --- | --- |
| `createNotification`（`store.ts:149`） | `publish({ kind: 'created', notification: row });` |
| `resolveNotification`（`store.ts:218`） | `publish({ kind: 'resolved', id: target });` |
| `dismissNotification`（`store.ts:228`） | `publish({ kind: 'dismissed', id: target });` |
| `expireNotification`（`store.ts:244`） | `publish({ kind: 'expired', id: target });` |

`incrementRetry`（`store.ts:257`）**不发布**——前端弹窗靠 `active.retryCount` 变化展示"还剩 N 次"，
本身已经是轮询驱动的"信号"；加 SSE 增量事件只会把数据流复杂化，且
yields/reminder 的 5 个写入点都不涉及 `incrementRetry`，poller 已在同一事务里
触发 `password_error` `createNotification`，前端会拿到一条新的 `password_error`，
完全够用。

**决策权衡**：

- **方案 A**（采纳）：store 层 publish。**最小侵入**，1 行/函数，5 处钩入，写入路径零分叉
- **方案 B**（拒绝）：路由层 GET 拿全表、diff 上一份缓存再发。 需要路由层持有"上次列表"状态、要做并发改 cron-like 周期 polling 才会发现事件，多 20+ 行且需要处理 db 直写绕过路由的场景（poller 内部调 store）

#### 2.2.3 SSE 端点：扩 `core/src/routes/notifications.ts`

新增 1 条路由，原有 4 条 GET/POST 不动：

```ts
// 新增在文件末尾；伪代码，最终用 Route 名 + 严格类型
notificationsRouter.get('/stream', (req: Request, res: Response) => {
  // 1. 鉴权：当前项目无鉴权，不做（与现有路由保持一致；待鉴权接入时统一加）
  // 2. SSE 必备响应头
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  // 3. 立即刷头，避免任何 proxy/浏览器 buffer 把首字节推迟到第一段数据后
  res.flushHeaders();
  // 4. 初次连接就送一条 hello，方便客户端确认连接建立
  res.write(`event: hello\ndata: {"ts":${Date.now()}}\n\n`);
  // 5. 心跳：25s 一条注释行，避开常见 30s/60s 反代超时
  const heartbeat = setInterval(() => {
    try { res.write(`: keepalive ${Date.now()}\n\n`); } catch { /* 已断 */ }
  }, 25_000);
  // 6. 订阅 bus
  const unsub = subscribe((ev) => {
    const payload = JSON.stringify(ev);
    try {
      if (ev.kind === 'created') {
        res.write(`event: notification\nid: ${ev.notification.id}\ndata: ${payload}\n\n`);
      } else {
        res.write(`event: ${ev.kind}\nid: ${ev.id}\ndata: ${payload}\n\n`);
      }
    } catch { /* 已断，下次心跳时清理 */ }
  });
  // 7. 客户端断开 / 服务端关闭：清心跳 + 退订
  const cleanup = () => {
    clearInterval(heartbeat);
    unsub();
    try { res.end(); } catch { /* noop */ }
  };
  req.on('close', cleanup);
  req.on('aborted', cleanup);
});
```

**响应头要点**：
- `Content-Type: text/event-stream` —— SSE 协议标识，EventSource 拒绝其它
- `Cache-Control: no-cache, no-transform` —— 阻止中间盒压缩 SSE 流
- `Connection: keep-alive` —— HTTP/1.1 默认即 keep-alive，显式写给反代看
- **`res.flushHeaders()`** —— Vite dev proxy 必备，否则首字节延迟到第一段数据后才发

**事件类型**（与 bus 1:1 对应）：

| SSE `event:` | 触发 | 载荷 |
| --- | --- | --- |
| `hello` | 连接建立 | `{ts}` |
| `notification` | `createNotification` | 完整 `NotificationRow` |
| `resolved` | `resolveNotification` | `{id}` |
| `dismissed` | `dismissNotification` | `{id}` |
| `expired` | `expireNotification` | `{id}` |
| `:` 注释 | 25s 心跳 | 无 |

**决策权衡**：

- **方案 A**（采纳）：广播全量 + 前端负责 merge。**简单**，全事件一份载荷；前端拿 `notification` 就直接 `setNotifications(prev => unshiftById(prev, ev.notification))`，拿 `resolved`/`dismissed`/`expired` 就 `setNotifications(prev => prev.filter(n => n.id !== ev.id))`
- **方案 B**（拒绝）：广播 delta patch（{added: [...], removed: [ids]}）。客户端要维护 diff 状态机，单写者也有事件乱序问题（详见 §5）

### 2.3 前端：EventSource 替换轮询

#### 2.3.1 改动定位

只动 `app/src/features/notifications/NotificationCenter.tsx`：

```ts
// 当前（NotificationCenter.tsx:121-134）
useEffect(() => {
  mounted.current = true;
  void pollRef.current();
  const timer = window.setInterval(() => {
    if (processingId.current != null) return;
    void pollRef.current();
  }, POLL_INTERVAL_MS);
  return () => {
    mounted.current = false;
    window.clearInterval(timer);
    if (waitTimer.current != null) window.clearTimeout(waitTimer.current);
  };
}, []);
```

替换为：

```ts
useEffect(() => {
  mounted.current = true;
  void pollRef.current();        // 首屏仍走一次 REST，保证首帧有数据（SWR-style）
  if (typeof EventSource === 'undefined') {
    // 浏览器不支持：保留 30s 轮询（不删 setInterval 实现，注释清楚为什么）
    const timer = window.setInterval(/* 与原逻辑一致 */, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }
  const cleanupFns: Array<() => void> = [];
  openNotificationStream({
    onCreated: (n) => setNotifications(prev => upsertById(prev, n)),
    onResolved: (id) => setNotifications(prev => prev.filter(x => x.id !== id)),
    onDismissed: (id) => setNotifications(prev => prev.filter(x => x.id !== id)),
    onExpired: (id) => setNotifications(prev => prev.filter(x => x.id !== id)),
    onClose: () => {
      // 连续 5 次 onerror：关闭 ES、切回 30s 轮询兜底（启动与原逻辑相同的 setInterval）
    },
  }, cleanupFns);
  return () => {
    mounted.current = false;
    cleanupFns.forEach(fn => fn());
    if (waitTimer.current != null) window.clearTimeout(waitTimer.current);
  };
}, []);
```

#### 2.3.2 抽出纯函数 `app/src/features/notifications/stream.ts`

**职责**：封装 EventSource 的"创建 + 重连 + 降级"逻辑。**YAGNI**：不上 `eventsource` / `reconnecting-eventsource` 等第三方库，原生 EventSource 已含自动重连（默认 3s）。

```ts
// 纯函数 + 一个副作用入口。Vitest 单测覆盖纯函数部分
export interface BackoffConfig {
  initialMs: number;   // 推荐 1000
  maxMs: number;       // 推荐 30000
  factor: number;      // 推荐 2
}

/** 退避序列：1s, 2s, 4s, 8s, 16s, 30s, 30s, 30s...（首次断后立即重连，按序列等待） */
export function nextBackoff(attempts: number, cfg: BackoffConfig): number {
  const ms = Math.min(cfg.maxMs, cfg.initialMs * Math.pow(cfg.factor, attempts));
  return Math.round(ms);
}

/** 已存在的 helper 复用：toNotification / toNotificationList 来自 types.ts */
function upsertById(list: AppNotification[], n: AppNotification): AppNotification[] {
  const idx = list.findIndex(x => x.id === n.id);
  if (idx < 0) return [n, ...list];
  const next = list.slice();
  next[idx] = n;
  return next;
}

export interface StreamHandlers {
  onCreated: (n: AppNotification) => void;
  onResolved: (id: number) => void;
  onDismissed: (id: number) => void;
  onExpired: (id: number) => void;
  onClose: () => void;
}

export function openNotificationStream(h: StreamHandlers, cleanupFns: Array<() => void>): void {
  // 1. 创建 EventSource
  const es = new EventSource('/api/notifications/stream');
  cleanupFns.push(() => es.close());
  let attempts = 0;
  // 2. 监听各事件
  es.addEventListener('notification', (ev) => {
    const n = toNotification(JSON.parse((ev as MessageEvent).data).notification);
    if (n) h.onCreated(n);
    attempts = 0; // 成功通讯，重置退避计数
  });
  es.addEventListener('resolved', (ev) => {
    const id = (JSON.parse((ev as MessageEvent).data).id) as number;
    h.onResolved(id);
    attempts = 0;
  });
  es.addEventListener('dismissed', (ev) => { /* 同上 */ });
  es.addEventListener('expired', (ev) => { /* 同上 */ });
  // 3. 错误：EventSource 自带自动重连；我们只做"重连间隔的指数退避上限"
  //    浏览器实现是 onerror 后 3s 重连；我们改用一个标志位 + 切到轮询兜底
  es.onerror = () => {
    // EventSource 自动重试：什么都不做，浏览器会在 ~3s 后重连
    // 我们仅在"持续失败"时退到轮询：连续 N 次 onerror（attempts >= 5）就关掉 ES
    attempts += 1;
    if (attempts >= 5) {
      es.close();
      h.onClose();
    }
  };
}
```

**关键决策**：

| 决策 | 候选 | 取舍 |
| --- | --- | --- |
| 自动重连 | A) 浏览器原生 EventSource（默认 3s）；B) 手写指数退避 | **A**：浏览器原生已实现 RFC 5.1 自动重连，3s 起步已经够短。手写只多了复杂度，0 收益 |
| 重连上限 | A) 无；B) 连续 N 次失败后关掉 ES、改走轮询 | **B**：连续失败说明服务端挂了或代理断了，原生重连只会打日志噪音；切回轮询让"通知中心依然工作" |
| 退避参数 | A) 1s/2s/4s/8s/16s/30s；B) 固定 3s | **A（保留参数但只用于切回轮询前的判定）**：原生重连固定 3s 我们管不了；切轮询前的指数计数只是"失败持续多久算挂了"的判定 |
| 多标签页 | A) 各自连接；B) BroadcastChannel 共享 | **A**：本项目用户量级是个人单用户、≤10 标签页；N 个长连接对 SSE 几乎没有成本（Node keep-alive），多标签广播又引入了同步问题。**YAGNI** |
| 数据合并 | A) 前端 `upsertById`；B) 任何事件都重拉 REST | **A**：事件载荷已是完整 NotificationRow，省一次往返；浏览器 EventSource 自动保证顺序 |

#### 2.3.3 不动的部分

- `poll()` 函数保留——首屏调用一次兜底、处理期间 +30s 兜底（`scheduleImportCheck`）、ES 切轮询时复用
- `POLL_INTERVAL_MS = 30_000` 保留——降级路径用它
- `processsingId` / `waitRounds` / `waitTimer` 全保留
- 第二个 `setInterval`（toast 清扫，`NotificationCenter.tsx:184`）保留——与通知业务无关
- `pickModalNotification` / `pickToastNotifications` 等纯函数**不动**

### 2.4 与 need_password 弹窗的交互

| 当前行为 | SSE 启用后 |
| --- | --- |
| poller 写入 `need_password` → ≤30s 后前端拉到 → 弹窗 | poller 写入 → SSE `notification` 事件 ≤1s → 弹窗 |
| 用户提交密码 → POST → 30s 后前端再拉一次判定导入完成 | 用户提交密码 → POST → poller 下次轮询写入 `import_success` + `resolve(prevId)` → SSE `notification` + `resolved` → 前端从列表移除 → useEffect 收尾 + pushToast |
| 密码错误：30s 后 retry_count++ | 密码错误：poller 写 `password_error` → SSE → `upsertById` 更新 retryCount → useEffect 触发"还剩 N 次"提示 |

→ 弹窗收尾（"通知已从 pending 消失 ⇒ 后端 resolve 了"）这条 useEffect（`NotificationCenter.tsx:200-212`）**不变**，因为 `setNotifications(prev => prev.filter(x => x.id !== id))` 与原轮询结果完全等价。

**保留 scheduleImportCheck 的理由**：单条 SSE 丢了（反代断 / 服务端重启）的话，`processing` 状态不会自然退出；30s 兜底拉一次保证这条死路不会卡用户。SSE + 兜底 = "乐观但不僵硬"。

### 2.5 测试方案

#### 2.5.1 core 端（`core/tests/notifications.test.ts` 追加 `describe`）

**测点 A：store publish 触发**（纯函数）

```ts
// 注入一个 fake subscriber，断言 createNotification 后收到 'created'
const seen: NotificationEvent[] = [];
const unsub = subscribe(ev => seen.push(ev));
createNotification(memDb, { type: 'need_password', title: 'bus: 收到' });
expect(seen).toHaveLength(1);
expect(seen[0].kind).toBe('created');
unsub();
```

**测点 B：resolve/dismiss/expire publish**

```ts
// 类似，验证 4 个事件种类
```

**测点 C：HTTP GET /api/notifications/stream**（fake response）

```ts
// 用 EventSource 客户端去连 baseUrl，监听 'notification' 事件
// 在另一处调 store.createNotification，断言 1s 内收到事件
```

**测点 D：心跳 + flushHeaders**

```ts
// 启动 stream，验证首字节立即是 hello（<100ms 内）
// 验证 25s 心跳注释（用 vi.useFakeTimers 加速）
```

**测点 E：客户端断开清理**

```ts
// es.close() 后调一次 createNotification，断言 store 内的 subscribers Set 不再持有
```

> **测试规模**：5 个 describe 块、共 ~10 个 it。不引入 supertest / axios 等新依赖；HTTP 测试沿用 `core/tests/notifications.test.ts:41-66` 的 `http()` + `app.listen(0)` 模式。

#### 2.5.2 app 端（`app/tests/notification-stream.test.ts` 新增）

**测点 F：`nextBackoff` 序列正确**（纯函数）

```ts
expect(nextBackoff(0, { initialMs: 1000, maxMs: 30000, factor: 2 })).toBe(1000);
expect(nextBackoff(5, { ... })).toBe(30000); // 1*2^5=32000 → 上限 30000
expect(nextBackoff(10, { ... })).toBe(30000); // 永远 ≤ maxMs
```

**测点 G：`upsertById` 行为**

```ts
// 已有 id → in-place 替换；新 id → unshift；保持顺序不变
```

**测点 H：openNotificationStream 集成**（可选，复杂）

```ts
// 用 jsdom 或 node-fetch + EventSource polyfill 测：
// - 收到 notification 事件 → 调 onCreated
// - 5 次 onerror 后 → 调 onClose
// 暂不写，等真正实施时根据 EventSource mock 库的可用性决定
```

> **最小可行**：F + G 两个纯函数单测即可——`openNotificationStream` 的副作用留给 Playwright 冒烟。

#### 2.5.3 验收：`accept/scripts/sse-notify.mjs`（可选）

- 起 hifin-core（8787）+ vite（5173），打开首页
- `EventSource` 注入 page context（或监听 window.console）
- 通过 CLI 触发 `mail poll`（或直接 SQL 写一条 need_password）
- 断言 ≤3s 内前端 store 状态更新、Modal 弹出

> **YAGNI**：本项目只有 1 个用户，验收脚本优先级低；先做 core 单测 + app 纯函数单测足矣。

---

## 三、改动清单（预估 diff 规模）

> 单元："行"指新写+修改总行数估算（含注释）。

### 3.1 core 端

| 文件 | 性质 | 行数 | 说明 |
| --- | --- | --- | --- |
| `core/src/notifications/bus.ts` | **新增** | ~40 | subscribe / publish；类型 5 行 + 实现 ~15 + 注释 ~20 |
| `core/src/notifications/store.ts` | 修改 | ~10 | 4 处 publish 调用 + 1 处 import |
| `core/src/routes/notifications.ts` | 修改 | ~50 | 1 个新 GET /stream 路由 + 1 处 import |
| `core/tests/notifications.test.ts` | 修改 | ~80 | 追加 bus publish 5 个 it + HTTP stream 2 个 it |

**core 小计**：~180 行（含测试 ~80 行）

### 3.2 app 端

| 文件 | 性质 | 行数 | 说明 |
| --- | --- | --- | --- |
| `app/src/features/notifications/stream.ts` | **新增** | ~90 | nextBackoff / upsertById / openNotificationStream |
| `app/src/features/notifications/NotificationCenter.tsx` | 修改 | ~30 | useEffect 内 30s setInterval → EventSource |
| `app/tests/notification-stream.test.ts` | **新增** | ~60 | nextBackoff + upsertById 纯函数测试 |

**app 小计**：~180 行（含测试 ~60 行）

### 3.3 不动

- `core/src/server.ts`：路由挂载点不变（`server.ts:67` `app.use('/api/notifications', notificationsRouter)`），新增路由自然被命中
- `app/vite.config.ts`：proxy 已经是 `/api` 通配，SSE 自然走通；**不需要** 加 `eventStream: true`（http-proxy 默认即流式）
- `core/src/db/*`：SSE 端点不写库
- `core/src/yields/reminder.ts`、`core/src/mail/poller.ts`：写入路径不变，自然触发 store publish
- `app/src/hooks/useApi.ts`：与本任务无关
- 现有 14 条 REST 接口的 schema 不动

---

## 四、风险与边界

### 4.1 Vite dev proxy 缓冲

- **风险**：未调 `res.flushHeaders()` 时，首字节延迟到第一段数据后才会发；浏览器 EventSource 会被认为"连接挂起"几秒
- **缓解**：路由层强制 `res.flushHeaders()` + 立即写 `hello` 事件（已在 §2.2.3 设计内）

### 4.2 HTTP/1.1 连接数

- **风险**：浏览器对**同源** HTTP/1.1 长连接默认上限 6 个；多标签页同时连 SSE 会被排队
- **影响**：本项目单用户、≤10 标签页；触发上限的窗口期是"每个标签页 + 其它已有长连接（fetch in-flight）"
- **缓解**：**不缓解**。HTTP/2 / HTTP/3 下没有此问题；本项目 dev 是 vite（HTTP/1.1），生产若用反代基本是 HTTP/1.1。若未来观察到卡顿，再考虑 BroadcastChannel 共享（§2.3.2 决策表已记录为 YAGNI）

### 4.3 SSE 断线/失败降级

- **场景**：服务端重启、反代超时、浏览器切后台被冻结
- **当前设计**：原生 EventSource 自动 3s 重连；连续 5 次失败后切回 30s 轮询
- **残留风险**：5 次 × 3s = 15s 内通知可能丢失（不被前端感知）。**接受**——store 写完不会丢，下次重连/轮询自然重新拉到

### 4.4 事件乱序

- **场景**：同一进程内 `resolveNotification` 与 `createNotification` 几乎同时触发，订阅者端 `created` 与 `resolved` 的事件顺序**应该**与写入顺序一致（bus 是同步 for-loop）
- **确认**：bus 同步派发，订阅者是 SSE response.write（同步入 socket 缓冲）；同一 Node 进程内不可能出现倒序。**多进程**才需要处理（当前架构无此问题）

### 4.5 SQLite WAL 单写者

- SSE 端点**不写库**，仅订阅事件；写者仍是同步 `createNotification` 单调用路径
- 唯一新增的资源占用：bus 内 `Set<Subscriber>` 的 1 次引用 / 客户端
- **无影响**

### 4.6 鉴权

- **现状**：所有 `/api/*` 路由都无鉴权（个人本地工具）
- **SSE 与否不改变**：保持一致即可
- **未来**：若加鉴权，需要在 SSE 路由里读 cookie 或 header，再 `res.status(401).end()`——届时统一处理

### 4.7 与 yields 催填的交互

- `core/src/yields/reminder.ts:200` 创建 `yield-reminder` → bus `notification` → 前端 `setNotifications(upsert)` → `pickModalNotification` 看到这条 → **会**走"弹窗"路径
- **检查**：`needsPasswordModal`（`logic.ts:99-101`）只对 `need_password` / `password_error` 返回 true；`yield-reminder` 不命中 → **不会**误弹窗
- `pickToastNotifications`（`logic.ts:125-132`）只对 `import_success` / `import_failed` 命中；`yield-reminder` 不命中 → **不会**误 toast
- **结论**：SSE 后 yield-reminder 会进入列表但无 UI 副作用。需要看 UI 上有没有"催填列表"组件——若没有，这条通知就在用户视野外静默存在，直到他填了收益率（`core/src/yields/reminder.ts:165` `resolveNotification` → bus `resolved` → 前端移除）
- **决策**：保留现状，与原轮询行为完全等价

### 4.8 CLI 触发的通知

- `mail poll`（`core/src/cli.ts`）触发 `MailPoller.runMailPoll()`，内部走 `mail/poller.ts` → `store.createNotification` → bus publish
- **正常路径**：若前端有连着的 SSE，能即时收到
- **CLI-only 场景**（无前端）：事件发布但没人订阅，无副作用
- **结论**：与原架构兼容

### 4.9 测试夹具的 EventSource

- core 端用真实 `app.listen(0)` + 原生 fetch；可用 `new EventSource(baseUrl + '/api/notifications/stream')` 真测
- app 端 vitest 跑在 `environment: 'node'`（`app/vitest.config.ts:8`），**没有 `EventSource`**——所以 `openNotificationStream` 的副作用测试要么 mock 要么跳过，**纯函数（nextBackoff / upsertById）测试必须先写**
- 决策：先把纯函数测了；副作用部分由 core 端测覆盖（同一份 store + bus），前端只测业务逻辑

---

## 五、开放问题

1. **retry 增量事件**：要不要在 `incrementRetry` 后也 publish？当前决定是**不**——`password_error` 的 `created` 已经能覆盖 UI 需求，且前端弹窗的"retryCount 变化"信号靠 `notification` 事件完整载荷里的 `retry_count` 字段就够了
   - 验证路径：在 §4.7 同样的 useEffect（`NotificationCenter.tsx:229-238`）里，`upsertById` 替换通知后会触发 `[active]` 重算 → 错误提示照常工作
   - **若实施后实测失败**（极端场景：poller 在 30s 内 +1 但没创建新通知），再加 `kind: 'retried'` 事件

2. **batch flush**：如果同一进程 1s 内写 100 条通知，是否要合并成一个事件？**当前不合并**——每个事件单发，前端 100 次 `setNotifications`。React 18 自动批处理足够，UI 上看不出 100 次更新。**保留单发**，等真出问题再说

3. **历史重放**：用户从昨天关机到今天开机，错过了若干通知。SSE 只推"未来事件"，历史靠 `GET /api/notifications?status=pending` 拿
   - **首屏调用一次 `poll()` 已覆盖**（NotificationCenter.tsx:124 改前即如此）
   - **不解决**：把"启动后立即拉一次全量"挪进 SSE 协议（避免轮询首屏）— YAGNI

4. **CORS**：vite dev proxy 同源，不需要 CORS；生产若直接暴露 8787 端口给前端，才需要。这里不动

5. **schema 迁移**：store 没动 schema，无迁移

---

## 六、验收 checklist

- [ ] `core/tests/notifications.test.ts` 新增 5+2 个 it 全过
- [ ] `app/tests/notification-stream.test.ts` 新增 ~6 个 it 全过
- [ ] core `pnpm test`：~393 → ~403 例通过
- [ ] app `pnpm test`：~177 → ~183 例通过
- [ ] 起 core (8787) + vite (5173)，打开 `/home`：
  - [ ] Network 面板看到 `/api/notifications/stream` 一直挂接
  - [ ] CLI 跑 `mail poll`（或 SQL 写一条 need_password）→ ≤3s 内前端 Modal 弹出
  - [ ] Modal 提交密码后，≤3s 内 toast 弹出"导入成功"
- [ ] 杀掉 core → vite 自动重连 5 次后切回 30s 轮询；重启 core → ≤10s 内重新连上 SSE

---

## 七、相关设计原则呼应

- 复用既有 helper：`pickModalNotification` / `pickToastNotifications` / `toNotification` / `upsertById`（已存在的 `toNotificationList` 路径不变）
- 最小 diff：仅 4 文件新增 / 修改，全在 notifications 子模块与 SSE 路由
- YAGNI：不引第三方库、不做 BroadcastChannel、不做 batch flush、不加鉴权、不做 schema 变更
- 删除优于新增：保留两处 setInterval 中与 SSE 重叠的那一条（30s 业务轮询），另一条（toast 清扫）不动
