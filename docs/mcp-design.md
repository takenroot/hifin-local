# HiFin MCP Server 设计

> 立项动机：让 Claude Code / Cursor 等 AI Agent 直接通过 MCP 协议调用 HiFin 查账、触发账单导入，不再开 REST。
>
> 调研范围：core 现有可复用逻辑 / 工具清单 / 传输选型 / 依赖决策 / CLI 集成 / 密码状态机在 MCP 下的映射 / 改动规模。
>
> 本文件是调研与设计稿，**不包含落地 commit**。落地时按本文件 §5 改动清单分两批推：第一批仅引入 stdio 入口 + 只读查询；第二批再叠加 import-bill / mail poll 两个写工具。

---

## 0. 术语与原则

- **MCP** = Model Context Protocol。AI 端（host）通过它发现并执行远端"工具"，最常见的传输是 **stdio**（host 直接拉起子进程，把 JSON-RPC 写到 stdin/stdout）。
- **工具 tool**：host 看到的、可被 LLM 调用的有名字的函数；每个工具有 `description` + JSON Schema 描述的 `inputSchema`，handler 返回 `{ content: [{ type: "text", text: "..." }] }`。
- **资源 resource**：host 看到的、可被读取的命名 URI；host 主动拉而不是 LLM 调用。本设计**只做 tools 不做 resources**——历史背景全部沉淀到 `description` 与返回值里，避免 host 端再去拼一份资源树。
- 本文档遵守 `docs/design-principles.md`：最小 diff / 复用现有 helper / YAGNI / 不新增抽象 / 删除优于新增。
- 本文档遵守 ponytail 阶梯：能用 stdlib + 已装依赖时绝不引入新依赖；如确实需要也挑最小代价的。

---

## 1. 现状盘点（精确到文件:行号）

### 1.1 进程入口与 CLI 形状

- 入口 `core/src/cli.ts:96` 起步，commander 程序，根 `program` 带 `--db <path>` 与 `--human`；子命令 `serve` / `accounts` / `tx` / `summary` / `import-csv` / `import-bill` / `mail config` / `mail poll`。
- 路由型服务入口 `core/src/server.ts:44` 的 `createApp({ dbPath })`：挂上 15 个 router，调用 `migrate` + `ensureSeed`。
- 共享 db 单例：路由层用 `core/src/routes/_db.ts:18` 的 `setActiveDb/getDb()`；db 模块 `core/src/db/connection.ts:27` 的 `openDatabase(path)`；CLI 走 `ensureDb(dbPath)`（`cli.ts:49`）。

> **可复用结论**：MCP 子命令**也只需要 `setActiveDb(openDatabase(dbPath))` + `migrate + ensureSeed`**——和 `serve`、`import-bill` 完全同一段，不需要新连接模式。
> **必须绕开**：所有 `core/src/routes/*.ts` 的 Express handler。它们的输入来自 `req.query` / `req.body`、输出走 `res.status().json()`，与 MCP tool handler 的 `Record<string, unknown>` 入参与 `{ content: [...] }` 出参不兼容。**不抄它们的代码**。

### 1.2 可被 MCP 工具复用的纯函数（已存在的、命名良好的）

盘点过 15 个路由后，**只有 4 处**真正值得抽出来复用：

| 位置 | 函数 / 逻辑 | 是否可直接调用 | 备注 |
|---|---|---|---|
| `core/src/routes/accounts.ts:70` `selectAccounts(where, params)` + `:88` `withLatestYield(rows)` | 账户列表 + latestYield 装配 | ✅ 直接 SQL 段，可重写（已带 LEFT JOIN accountYields) | 不依赖 req/res |
| `core/src/routes/summary.ts:24` `monthRange(monthStr)` | YYYY-MM → `[start, end)` 半开区间 | ✅ 纯函数 | **唯一被 export 的 helper**，见 `summaryHelpers` at `:139` |
| `core/src/routes/summary.ts:44` `calcNetAsset(accounts)` | 净资产（credit/debt 用 `-balance`，见 ISSUE-004） | ✅ 纯函数 | 同上，已 export |
| `core/src/routes/summary.ts:58` `sumTx(txs, type, start, end)` | 月内收入/支出汇总 | ✅ 纯函数 | 同上 |
| `core/src/notifications/store.ts:180` `listNotifications(db, filter)` | 通知列表 | ✅ 显式 export | — |
| `core/src/bill/importer.ts:253` `importBillZip(db, zipPath, platform, password, accountId, spaceId?, onProgress?, accountMap?)` | 完整账单 ZIP 导入（含解压/解析/落库） | ✅ 显式 export | 注意 `BillPasswordError` / `BillFormatError` / `BillCsvNotFoundError` 三类错误，见 `bill/unzip.ts:40` 等 |
| `core/src/mail/poller.ts:1314` `runMailPoll(db, opts)` | 完整 IMAP 轮询编排 | ✅ 显式 export | — |
| `core/src/mail/poller.ts:1187` `readMaskedMailConfig(db)` | 读掩码后 IMAP 配置（密码 `******`） | ✅ 显式 export | host 永远拿不到明文密码 |
| `core/src/bill/password-store.ts:31` `setBillPassword(uid, password)` | 暂存某条邮件的解压密码 | ✅ 显式 export | 一次性，进程内 Map，**不落盘** |

剩下的路由 handler（`/api/transactions`、`/api/categories`、`/api/rules`、`/api/accounts` 含 PUT/DELETE、`/api/goals`、`/api/budgets`、`/api/tags`、`/api/merchants`、`/api/reports`、`/api/spaces`、`/api/kv`、`/api/ai-models`）都是 SQL + 校验 + Express 包装三段粘连；**抽函数 = 重写一遍路由**，纯增量无收益，本设计不抽。

> **Reuse 决策**：MCP tool handler 直接调用上面 9 处 export，**其余工具重写 5~10 行 SQL**——见 §2 工具清单的"复用 sql"备注。这与 `docs/design-principles.md` 第 2 条"复用现有 helper"对齐；不达第 3 条"stdlib 已经做了"时（这里没有 stdlib 等价物），落第 7 条"最小工作代码"。

### 1.3 账单密码的现状**

`core/src/bill/password-store.ts:17` 一个**进程内**的 `Map<uid, password>`；REST 端点 `core/src/routes/bills.ts:15` `POST /api/bills/:uid/password` 调 `setBillPassword`。**MCP tool 直接复用同一份 Map**——不需要桥接，因为 MCP 子进程就是同一进程。

- `core/src/mail/poller.ts:582` 默认 `this.passwords = this.opts.billPasswords ?? getBillPasswordMap()`：poller 读的就是这份共享 Map。`runMailPoll` 通过 `opts.billPasswords` 覆盖；不传即共享。
- `core/src/notifications/store.ts:217` `resolveNotification` 与 `:228` `dismissNotification` + 状态机 `poller.ts:808~826`（重试到 3 次转 `failed`）共同实现 `need_password → password_error ×3 → failed` 的状态机。

### 1.4 mail poll 状态机对 MCP 的影响

mail poller 是**异步长操作**——可能跑十几秒到几分钟，且会在内部产生 `need_password` 通知。两种处理路径：

| 路径 | 优点 | 缺点 |
|---|---|---|
| **A. MCP tool 同步调用 `runMailPoll`，等返回 summary** | 一次调用 = 一次完整轮询，与 CLI 行为 1:1 | 如果邮件需要密码，调用方要监听 `notifications` 端点；host 通常不主动轮询；密码不会自己送回 |
| **B. MCP tool 只触发一次，立即返回 `{ runId, status: 'started' }`，让 host 后续用 `listNotifications` 查 `need_password`，再调 `submit_bill_password`，再调 `poll_status`/`poll_now` 触发重试** | 完美对接 password 状态机；host 看到的是能力调用而不是结果 | 多 3 个工具；与 CLI 行为不完全 1:1 |

**本设计选 B**——AI Agent 调用方能自然地"看到通知 → 让用户口述 → 提交给密码 → 再投币一次"。CLI 路径 A 保留不变。

### 1.5 vitest + ts 现状

- `core/package.json:14-19` 仅 5 个 runtime 依赖：`adm-zip / better-sqlite3 / commander / express / imapflow / xlsx`，无 zod / 无 MCP 客户端。
- `core/vitest.config.ts:11` `pool: 'threads'`（绕开 better-sqlite3 11 在 fork 模式下的 native cleanup 冲突；现已升 13，问题可能消失，但留着无害）。
- 测试策略：`core/tests/api.test.ts:37-51` 拉真实 HTTP（`createApp + listen(0) + native fetch`），`:memory:` db + `setActiveDb`；`core/tests/notifications.test.ts:55-60` 同样拉服务，但额外直接调 store 层。

---

## 2. 工具清单（v1 全部只读 + 2 个显式写工具）

命名采用**对象动宾结构** `hifin_<domain>_<action>`，避免和 REST URL 路径拼写不同造成认知负担。Description 中文 + 一行英文，确保 host 的 LLM 看到中文也能 fallback 到英文匹配。

> **写工具只有 `import_bill` 与 `mail_poll`，且都标注为 `mutating: true`**——host 的 LLM 会自动避开它们提示用户二次确认。MCP 协议本身没有 `mutating` 字段（截至 2026-07-28 规范）；本设计把它装进 description 文本的前缀 `[mutating]`。**这是约定不是强约束**。

### 2.1 只读工具（首批上线）

| name | description (前 60 字) | input schema | 复用点 |
|---|---|---|---|
| `hifin_health` | `健康检查；返回 db 是否可读 + 当前时间戳` | `{}` | `openDatabase().pragma('user_version')` |
| `hifin_accounts_list` | `账户列表（含每个账户的最新年度收益）；可选按 spaceId 过滤` | `{ spaceId?: number }` | `selectAccounts + withLatestYield` (`routes/accounts.ts:70/88`)，或内联改写 |
| `hifin_accounts_yields` | `某账户的年度收益历史（按年倒序）` | `{ accountId: number }` | 直接 SQL `accountYields` 表（routes 那边同口径 SQL） |
| `hifin_transactions_query` | `条件查询交易流水，支持 from/to 时间戳、type、accountId、spaceId、limit` | `{ from?: number, to?: number, type?: 'expense'\|'income'\|'transfer'\|'excluded', accountId?: number, spaceId?: number, limit?: number (≤500, 默认 100) }` | 内联 SQL（与 `routes/transactions.ts:97-159` 同样的 where 拼接） |
| `hifin_summary_month` | `看板月度汇总：净资产 + 当月收入/支出/净额 + 环比（delta/百分比）` | `{ month?: 'YYYY-MM' (默认当月) }` | `monthRange + calcNetOfWithSelect + sumTx` (`routes/summary.ts:24/44/58`)，**已 export** |
| `hifin_categories_list` | `列出所有分类（支出/收入两方向）` | `{}` | `SELECT * FROM categories ORDER BY id ASC` (`routes/categories.ts:13-19`) |
| `hifin_rules_list` | `列出所有规则（可按 enabled/categoryId 过滤）` | `{ enabled?: boolean, categoryId?: number }` | 同口径 SQL（`routes/rules.ts:42-71`） |
| `hifin_notifications_list` | `通知列表（need_password / yield-reminder / ...），按 createdAt DESC` | `{ status?: NotificationStatus, type?: NotificationType, limit?: number }` | **`listNotifications(db, filter)` 直接调** (`notifications/store.ts:180`) |

### 2.2 写工具（第二批上线，二次确认后接入）

| name | description | input schema | 复用点 |
|---|---|---|---|
| `[mutating] hifin_import_bill` | `[mutating] 解压账单 ZIP 并导入指定账户；密码必填；返回 imported/skipped` | `{ zipPath: string, platform: 'alipay'\|'wechat', password: string, accountId: number, spaceId?: number }` | **`importBillZip(db, ...)` 直接调** (`bill/importer.ts:253`) |
| `[mutating] hifin_mail_poll` | `[mutating] 触发一次 IMAP 轮询；返回 fetched/imported/errors 摘要；如果到达账户密码，需要再调 hifin_mail_submit_bill_password 后再调一次本工具` | `{ days?: number (默认 7), accountId: number, spaceId?: number }` | **`runMailPoll(db, opts)`** (`mail/poller.ts:1314`) |
| `[mutating] hifin_mail_submit_bill_password` | `[mutating] 提交某条账单通知的解压密码（一次性）；存入进程内 Map，下一次 hifin_mail_poll 触发 import 会自动取走` | `{ uid: number, password: string }` | **`setBillPassword(uid, password)`** (`bill/password-store.ts:31`) |

### 2.3 不做的工具（明确划界）

- **不做** `add_transaction` / `update_transaction` / `add_account` 等通用 CRUD。原因：和 web SPA + REST + REST 一致——MCP 是**查询**层接口；写流水让用户在 Web 端做。AI 误改 841 笔已有数据的代价远高于收益。如果未来真要加，**只加 `add_manual_transaction` 一个、且要二次确认对话框**——这超出本设计范围。
- **不做** `kv_get / kv_put` / `ai_models_*`：内部状态与凭证，不属于 AI 应该瞎碰的范围。
- **不做** `goals_*` / `reports_*`：体量大的现状（目标进度计算、报表订阅配置）目前没有 AI 自动化诉求；YAGNI。
- **不做** resources / prompts：MCP 规范允许，但本项目没有适合 `router.use()` 暴露的内容；加了只会让 host 看到一个空壳。

---

## 3. 传输选型：stdio（本地 AI Agent）

### 3.1 候选与决断

| 候选 | 适用 | 否决理由 |
|---|---|---|
| **stdio（子进程 + stdin/stdout JSON-RPC）** | 本地 AI Agent（Claude Code / Cursor / VS Code） | ✅ **本场景所有 host 都用 stdio 拉起本地 server** |
| HTTP+SSE（远程 / 跨进程） | 远程 / 多人共享 | 现有 REST 已经覆盖；做 cloud-only 不是 v1 目标。**架构上留接口**（handler 与 transport 解耦），以后若要 HTTP+SSE 不重写 |
| WebSocket | 浏览器内 AI | 浏览器内 AI 现在也走 stdio 子进程；不必要 |

**选 stdio**：
1. **零鉴权**：host 直接 fork 本地子进程，user 已经登录了电脑，db 文件在 user 家目录下，没有网络暴露面。MCP 规范 2026-07-28 推荐本地场景默认 stdio。
2. **零额外进程**：复用 `setActiveDb + migrate + ensureSeed` 同一段，与 CLI/serve 完全一致；`process.exit` 之前 db 自动关。
3. **零网络栈**：stdio 走 `process.stdin / process.stdout` 两行 Node stdlib；HTTP+SSE 要拉 express、监听端口、处理 CORS、防火墙——纯增量无收益。
4. **跨 host 兼容**：Claude Code / Cursor / VS Code / Zed 默认 worker 拉到 mcp server 都用 stdio 启动命令；HTTP+SSE 的 host 配置**各家不一致**（Claude Code 支持，VS Code 走 SSE/Custom Transport），维护成本高。

### 3.2 多实例 / 并发连接

- host 一般 fork **一个** server 子进程、一个 stdio；用户切换 host 就关上一个、开下一个。
- **并发同进程**：host 偶尔会并发发 2~3 个 tool call（如"列出本月所有支出 + 列出本月所有收入"两个并发 query）。MCP 走 JSON-RPC over stdio = 单连接流，**handler 必须能并发执行**。better-sqlite3 是同步阻塞的，每个 statement 微秒级，并发 3 个 tool call 在同一进程内串行执行没问题——但**handler 内部不能再起 `await` 跨调用**（比如等 5 秒通知）；否则 stdio 管道会被阻塞，host 看不到进度。
  - 缓解：`hifin_mail_poll` 是长跑，handler 在 `await runMailPoll` 期间 stdio 是阻塞的。这是 stdio 的固有限制，不在本设计解决范围；如果用户报告"卡住"，fallback 是改 HTTP+SSE。
- **跨进程**：如果用户在两个 host 里同时挂着 hifin mcp server，会同时写同一个 `core/data/hifin.db`。better-sqlite3 已启用 WAL (`db/connection.ts:38`)，跨进程写 OK；**但 `getDb()` 单例在 connection.ts 内是进程内的，不跨进程冲突**。两条 stdio 共用一个 db 文件，写冲突由 SQLite 兜底（写锁等）。
  - 不在 v1 解决；现状（Web SPA + 多 CLI）已能容忍同一 db 文件并存多写。

### 3.3 跨架构的解耦：handler 与 transport 分开

落地时所有 tool handler 写成**纯函数** `(args: Record<string, unknown>, ctx: { db: Database.Database }) => Promise<{ content: Array<{type:'text', text:string}> }>`；stdio transport 与后续可能的 HTTP+SSE transport 只做"读 JSON-RPC → 调 handler → 写 JSON-RPC"。

> 这也是 stdio MCP SDK 与我们的契合点（参见 §4）——SDK 提供的就是 `serveStdio(() => McpServer)` 与 `server.registerTool(name, schema, handler)`。

---

## 4. 依赖决策：用 @modelcontextprotocol/sdk

### 4.1 候选对比

| 方案 | 代码量（估） | 风险 |
|---|---|---|
| **A. 引入 `@modelcontextprotocol/sdk`（@modelcontextprotocol/server + /stdio 子包）** | handler 写法固定、~150 行 glue；JSON-RPC / 心跳 / 协议版本协商全交给 SDK | 一次依赖；体积~300KB；升级随规范走 |
| B. 手写 JSON-RPC over stdio | readline + 协议栈 + 心跳 + schema 校验 → 估 ~400 行 | 维护负担；规范升级要自己跟；测试面更大 |
| C. 借 `commander` 的 stdio + 自定义协议 | 同 B，且把协议也自创了，host 端不认识 | ❌ 不走 |

**选 A**：
1. MCP 规范的 wire 协议有约 8 个 message kind（initialize / initialized / tools/list / tools/call / resources/list ...）+ 心跳 + capability 协商——手写就是一场小型框架工程。SDK 已经做完了，且 v2 跟最新规范（[2026-07-28 spec](https://modelcontextprotocol.io/specification/2026-07-28)）同步更新。
2. `@modelcontextprotocol/server/stdio` 子包仅导出 `serveStdio`，体积可控；handler 写法见 [TypeScript SDK 文档](https://ts.sdk.modelcontextprotocol.io/v2/index.md)——核心就是 `server.registerTool(name, {description, inputSchema: z.object(...)}, async (args) => ({content:[{type:'text', text:'...'}]}))`。
4. **代价只有 1 个 dep + zod 4**（inputSchema 用 `zod/v4`，SDK peer dep）；体量比任何手写方案都小。

### 4.2 与现有依赖对齐

`core/package.json:12-19` 当前 5 runtime 依赖。新增：

```jsonc
"@modelcontextprotocol/server": "^2.0.0",
"zod": "^4.0.0"
```

- **没有引入 MCP 客户端**：本项目只做 server，不做 host。
- **不引入 `@modelcontextprotocol/sdk`**：那个是 v1 命名，v2 已经拆 server/stdio/client 几个子包；选子包更小。
- **不引入 transport 库**（HTTP/SSE）：v1 不需要。
- **不引入 logging 库**：stdio 通道写日志会破坏 MCP 协议（host 解析 JSON-RPC 失败）——所有 stdout 必须只写 JSON-RPC 帧；日志走 stderr（host 一般不读 stderr，不会干扰协议）。这一条下层 M0 落地要 `console.error`、不 `console.log`。

### 4.3 位置：core 内同包

**放在 `core/package.json`**，不开子包。理由：

1. 11 个 tool handler 全要直接调 `getDb()`、`listNotifications()`、`importBillZip()`——这些都已在 core 里；开子包要重写一遍 import + tsconfig + vitest 试，**纯增量无收益**。
2. core 已经 `tsx watch src/server.ts` 跑 serve；mcp 子命令同样 `tsx src/cli.ts mcp` 起步，零构建链修改。
3. 现有 vitest threads pool 已绕开 better-sqlite3 fork 兼容问题（M0 不再修改 vitest 配置）。

---

## 5. 改动清单（两批落地）

### 5.1 第一批：stdio 入口 + 只读工具

**新增文件**（仅 2 个，est. ~150 LOC）：

1. `core/src/mcp/server.ts`（~120 LOC）
   - `export function createMcpServer(db: Database.Database) { ... }`
   - 内部 `new McpServer({ name: 'hifin', version: '0.1.0' })`
   - `registerTool` × 8：`hifin_health / hifin_accounts_list / hifin_accounts_yields / hifin_transactions_query / hifin_summary_month / hifin_categories_list / hifin_rules_list / hifin_notifications_list`
   - 每个 handler 内部走：zod 校验过的 args → 直 SQL 或复用 helper → `JSON.stringify({rows, meta})` → `{ content: [{ type: 'text', text }] }`
   - catch 抛 `Error('xxx')` → 走 SDK 默认错误响应（MCP 协议允许 `-32603 internal error`，SDK 会自动包）
   - 顶部加注释：复用 `routes/accounts.ts:70/88` 的 `selectAccounts + withLatestYield` 风格内联（避免 import Express 类型）；**不复用 routes 本身**

2. `core/tests/mcp-server.test.ts`（~120 LOC，~12 例）
   - 与 `tests/notifications.test.ts:55-60` 同模式：`openDatabase(':memory:') + setActiveDb + migrate` + `createMcpServer(db)`
   - 用 SDK 提供的 in-memory transport（v2 SDK 提供 `InMemoryTransport`，见 [ts.sdk.modelcontextprotocol.io/v2](https://ts.sdk.modelcontextprotocol.io/v2/index.md)）模拟 host：
     ```ts
     const client = new Client({ name: 'test', version: '0.0' });
     const [c2s, s2c] = InMemoryTransport.createLinkedPair();
     await Promise.all([client.connect(c2s), server.connect(s2c)]);
     const result = await client.callTool({ name: 'hifin_health', arguments: {} });
     ```
   - 测试覆盖：每个 tool 至少 1 例 happy path；schema 拒绝非法入参 1 例；空 db / 非空 db 各 1 例（用现有 seed 即可）

**修改文件**（est. +30 LOC）：

3. `core/src/cli.ts`
   - 末尾新增：
     ```ts
     program
       .command('mcp')
       .description('启动 MCP server（供 Claude Code / Cursor 等 AI Agent 连接）')
       .action(async () => {
         ensureDb(program.opts().db);
         const { createMcpServer } = await import('./mcp/server.js');
         const server = await createMcpServer(getDb());
         const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
         await serveStdio(() => server);
       });
     ```
   - 注意 `program.parseAsync(process.argv)` 已存在（`cli.ts:660`），自动 await；新子命令走同样路径。

4. `core/package.json`
   - `+ "@modelcontextprotocol/server": "^2.0.0"`
   - `+ "zod": "^4.0.0"`
   - 不改 tsconfig（dynamic import 在 Node 24 + tsc 5.6 下走默认 esm）

**diff 规模**：core 新增 ~270 LOC、修改 ~15 LOC、依赖 +2。**不触 db schema、不触 routes、不触 CLI 现有子命令**。

### 5.2 第二批：写工具 + 密码状态机

**新增文件**（est. ~80 LOC）：

5. `core/src/mcp/server.ts` 追加 3 个 `registerTool`（参见 §2.2）：`hifin_import_bill` / `hifin_mail_poll` / `hifin_mail_submit_bill_password`
   - `hifin_import_bill` 直接调 `importBillZip(...)`，把 `BillPasswordError / BillFormatError / BillCsvNotFoundError` 三类映射成 tool 返回的 `isError: true` + 文本说明（host 会展示给用户），不让 SDK 把它当 internal error。

6. `core/tests/mcp-server.test.ts` 追加 ~6 例：
   - `hifin_mail_submit_bill_password` 验证 `getBillPassword(uid)` 写进去了；再调 `clearAllBillPasswords`
   - `hifin_import_bill` 用一份 fixture ZIP（与 `tests/bill.test.ts` 同源 fixture）走 happy path；故意给错密码抛 `BillPasswordError`，断言 tool 返回 `isError: true` 且文案包含"解压密码"
   - `hifin_mail_poll` 用 `RunMailPollOptions.pollerFactory` 注入 fake poller（与 `mail.test.ts` 同套路），断言返回的 `imported`/`fetched` 与 fake stats 一致

**diff 规模**：core 追加 ~80 LOC。**复用**：`bill/importer.ts:253` / `mail/poller.ts:1314` / `bill/password-store.ts:31` 三处 export + 现有 fake poller 注入模式（`RunMailPollOptions.pollerFactory`，见 `poller.ts:1297`）。

### 5.3 总 diff 规模

| 文件 | LOC 增量 | 备注 |
|---|---|---|
| `core/src/mcp/server.ts` | +~200 | 11 个 `registerTool` |
| `core/src/cli.ts` | +~15 | 1 个 subcommand |
| `core/tests/mcp-server.test.ts` | +~180 | ~18 例 |
| `core/package.json` | +2 deps | `@modelcontextprotocol/server` + `zod` |
| **合计** | **~395 LOC + 2 deps** | 跨 4 个文件 |

未触：`db/*` schema / `notifications/store.ts` / `bill/*` / `mail/*` / routes/ / app/。所有"复用"都是调现有 export。

---

## 6. 测试与验收计划

### 6.1 单元测试（与现有约定一致）

- 测试框架：`vitest run`，与 `core/vitest.config.ts:11` 的 `threads` pool 一致（不动配置）。
- 数据库：`:memory:` + `setActiveDb + migrate + ensureSeed`，与 `tests/api.test.ts:37-51` / `tests/notifications.test.ts:55-60` 同套路。
- 进程 vs handler：**测 handler 函数本身，不起子进程**——SDK v2 提供 `InMemoryTransport.createLinkedPair()`，把 server 与 client 拉在同进程内（两端用 MessagePort 通信），比真正起子进程 stdio 简单、稳定、快。**参见 §3.3 的解耦**：handler 与 transport 解耦正是为了让测试能这么干。
- mock：第三方依赖（IMAP / ZIP）走现有 fake：pollerFactory 注入、fixture ZIP 复用 `tests/bill.test.ts` 的同源 fixture。
- 验收门：vitest 全绿，`core/tests/mcp-server.test.ts` 至少 18 例。

### 6.2 进程级 smoke（一次）

写一次 `accept/scripts/mcp-smoke.mjs`（与 `accept/scripts/darkmode-verify.mjs` 同模式）：

1. `tsx src/cli.ts mcp --db /tmp/test.db &` 拉起 server（fork 子进程 + stdio）
2. spawn 一个 client，按 SDK v2 用 `StdioClientTransport` 连
3. `tools/list` 拿到所有 11 个 tool
4. `tools/call` 调 `hifin_health` / `hifin_summary_month` / `hifin_transactions_query` 三个；断言返回 `{content:[{type:'text', text:'...'}]}`
5. 给 `hifin_mail_submit_bill_password` 写一个 fake uid + 密码，再读 `getBillPassword(uid)` 验证（这一步在 smoke 里可以省略；测试已覆盖）
6. `disconnect() + kill`

> smoke 脚本**不进 vitest**，按现有约定留 `accept/scripts/` 作为可复跑回归。

### 6.3 跨 host 真实调用（人工）

- Claude Code：加 `.mcp.json` 配置
  ```json
  { "mcpServers": { "hifin": { "command": "npx", "args": ["tsx", "core/src/cli.ts", "mcp", "--db", "/home/saltedfish/project/hifin/core/data/hifin.db"] } } }
  ```
- Cursor：同上（`.cursor/mcp.json`）
- 验证 11 个 tool 都能被 host 看到；调一次 `hifin_summary_month` 让 host 给用户讲一遍本月收支

---

## 7. 风险与开放问题

### 7.1 已知风险

1. **stdio 协议解析对 stdout 污染零容忍**。代码里任何 `console.log('debug')` / 未捕获的 `throw` 序列化到 stdout 都会让 host 解析 JSON-RPC 失败。落地约束——**所有日志走 `console.error`（走 stderr）；stdout 仅 JSON-RPC 帧**。SDK 默认遵守此约定，但落到 `createApp({...})` 的路由层一旦有 `console.log` 会污染 stdio；本设计**MCP 子进程不走 express，污染源被隔离**，但仍需要在 PR review 时盯一眼。
2. **多 host 共用同一文件**。WAL 让读并发 OK；写并发由 SQLite 串行兜底。如果用户在 Claude Code 与 Cursor 里同时挂了 hifin mcp server，都触发 `hifin_mail_poll`，可能并发抢同一个通知 uid——**目前没有锁**，但 `importBillZip` 内层走事务（`bill/importer.ts:314-316`），重复导入会被外部 UNIQUE 索引 `(source, externalId)` 兜底（见 schema v2，参见 `db/schema.ts:43-48`）。**不修，留 known-issues**。
3. **长操作阻塞 stdio**。`hifin_mail_poll` 可能跑 10 秒~1 分钟，期间 host 看不到进度。stdio 协议无 progress 通知字段——只有 `tools/call` 完成后才一次性返回**。用户感知是"AI 卡住了一会儿"。缓解：description 文本里明说"可能耗时较长"；不引入 HTTP+SSE 解决，因为本地场景下 1 分钟内的"卡住"AI 是能容忍的。
4. **`hifin_transactions_query` 无 limit 时可能返回 841 行**。841 行 JSON 化 ~300KB，stdin/stdout 管道缓冲 OK，但 host 上下文窗口会爆。**handler 内部强制默认 `limit=100`、`maxLimit=500`**（schema 层卡）；description 提示"返回 100 条以内；如需更多用 from/to 缩小范围"。这条与 `routes/transactions.ts` 现状不一致（路由无 limit），但 MCP 是给 AI 用的，AI 不需要 841 行——多了反而是 trade-off 错配。
5. **SDK v2 是新版本（2026-07-28 spec）**。如果 host 端 client 还没升到 2026-07-28，可能 negotiate 不到 capability。本设计假设用户的 host（Claude Code / Cursor / VS Code）在 v2 上线后已经在用——若发现某 host 还在 2025 spec 跑，rollback 路径是改用 `@modelcontextprotocol/sdk` v1（**已 deprecated 但 npm 还在**），revert2 是改 `server.registerTool` → v1 API。**不预先解决，等真实失败再说**。

### 7.2 开放问题

1. **要不要把 `hifin_summary_month` 拆成 `hifin_summary_net_asset` + `hifin_summary_month_flow` 两个 tool？** 当前合并版一次调用更省 round-trip；拆开更精确描述 LLM 的意图。本设计**保持合并**，理由：host 的 LLM 经常同时要看净资产 + 月度收支，分两次调用是浪费。
2. **`hifin_transactions_query` 要不要支持 `keyword` 模糊匹配？** Web SPA 的"交易关键字搜索"是 200ms 防抖、匹配 name/merchant/remark/categoryName（见 CHANGELOG §"新增 2026-10-03 下午：交易关键字搜索"）。MCP tool 给 AI 拼 LIKE 也能做，但会引入 SQL LIKE 注入风险；**v1 不做，让 AI 用 `from`+`to` 缩小范围**。
3. **要不要做 `hifin_recent_bill_imports`（列出最近 N 笔导入，含 source/externalId）作为导入的"对账"工具？** v1 不做；CHI 字段 `source/externalId/paymentMethod/status` 已在 `hifin_transactions_query` 返回里（见 `routes/transactions.ts:152-157` 注释），AI 自己 `query` 就够。
4. **`hifin_mail_submit_bill_password` 的 `uid` 是 IMAP UID，但 host 怎么拿到这个 uid？** 路径是 `hifin_notifications_list` → 过滤 `type='need_password'` → 读 `bill_uid` 字段。MCP description 里把这条调用链写明即可。
5. **MCP 协议是否允许 server 主动推送？** 当前 2026-07-28 spec 没有；只有 `tools/call` 的 request/response。意味着 `hifin_mail_poll` 拿不到密码时只能返回 `imported=0, skipped=N, hint='需要密码'`——**host 不能实时收到通知**。如果用户希望"AI Agent 自动在邮件到的时候告诉我"，需要走 IDLE/SSE 长连接，那是 `docs/sse-design.md` 的范围，与本设计**正交、不冲突**。
6. **要不要做 `hifin_mail_config_show`？** 读掩码配置（host 拿不到明文密码），对 AI 没有直接价值（AI 也不该知道用户邮箱）。**不做**。

---

## 8. 引用速查（写代码时按图索骥）

| 想做的事 | 调它 |
|---|---|
| 打开 db | `openDatabase(path)` `core/src/db/connection.ts:27` |
| 注入到路由层 / MCP 工具层 | `setActiveDb(db)` `core/src/routes/_db.ts:18` |
| migrate + seed | `migrate(db) + ensureSeed(db)` `core/src/db/migrate.js` / `seed.js`，cli.ts:50-53 已示范 |
| 月度区间 / 净资产 / 月度收入支出 | `monthRange / calcNetAsset / sumTx` `core/src/routes/summary.ts:24/44/58`（已 export at `:139`） |
| 通知列表 | `listNotifications(db, filter)` `core/src/notifications/store.ts:180` |
| 导入账单 ZIP | `importBillZip(db, zipPath, platform, password, accountId, spaceId?, onProgress?, accountMap?)` `core/src/bill/importer.ts:253` |
| 触发 IMAP 轮询 | `runMailPoll(db, opts)` `core/src/mail/poller.ts:1314`（可注入 pollerFactory） |
| 提交账单解压密码 | `setBillPassword(uid, password)` `core/src/bill/password-store.ts:31` |
| 读 IMAP 配置（掩码） | `readMaskedMailConfig(db)` `core/src/mail/poller.ts:1187` |
| CLI 新增子命令 | `program.command('…').action(async (opts) => { ... })`，参考 `cli.ts:534-570` 的 `import-bill` |

---

## 9. 落地 TODO（用户决策后再开始写代码）

- [ ] 第一批：加 `core/src/mcp/server.ts` + `core/tests/mcp-server.test.ts` + `core/src/cli.ts` 1 个 subcommand + `core/package.json` +2 deps
- [ ] 第一批验收：vitest 全绿 + Claude Code `.mcp.json` 配通、`hifin_summary_month` 调用成功
- [ ] 第二批：在 `core/src/mcp/server.ts` 追加 3 个写工具 + 追加 ~6 测试例 + smoke 脚本 `accept/scripts/mcp-smoke.mjs`
- [ ] 第二批验收：vitest 全绿 + smoke 全过 + 用户在 Claude Code 里走过完整流程"列通知 → 提交密码 → 触发轮询 → 导入成功"
- [ ] **不必**做的事：bot/curl 直调 mcp server 的验收（HTTP+SSE 是 v2 才有）；开新子仓库；引 MCP 客户端

---

**文档状态**：调研完成，待用户决策后按 §5 落地。MCP 是 **§3 stdio** + **§4 SDK v2** + **§5 11 个工具** 的组合。