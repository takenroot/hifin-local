# hifin-core

HiFin 核心服务 — Node 常驻进程，提供 REST API + CLI + IMAP 邮件轮询。

SQLite 是全系统唯一数据源，默认监听 `:8787`。

## 架构定位

```
hifin-core (SQLite 唯一数据源)
    ↑ REST API
    ├─ Web SPA (app/)
    ├─ CLI (AI/脚本调用)
    └─ Tauri App (未来内嵌)
```

## REST 资源

`/api/` 下共 15 个资源，定义在 `src/routes/`，由 `src/server.ts` 逐个挂载：

| 资源 | 路径 | 用途 |
| --- | --- | --- |
| accounts | `/api/accounts` | 账户 |
| transactions | `/api/transactions` | 流水 |
| summary | `/api/summary` | 看板汇总 |
| categories | `/api/categories` | 分类 |
| goals | `/api/goals` | 目标 |
| budgets | `/api/budgets` | 预算 |
| tags | `/api/tags` | 标签 |
| merchants | `/api/merchants` | 商户 |
| rules | `/api/rules` | 交易规则 |
| reports | `/api/reports` | 报表 |
| spaces | `/api/spaces` | 多空间 |
| kv | `/api/kv` | 杂项配置 / AI 会话 |
| ai-models | `/api/ai-models` | AI 模型配置 |
| notifications | `/api/notifications` | 通知与密码重试状态机 |
| bills | `/api/bills` | 账单导入 |

Web SPA（`app/`）已全面切到这套 REST API，浏览器端不再有自己的数据库。

## 开发

```bash
npm run dev        # tsx watch 启动 REST 服务（:8787）
npm run test       # vitest（265 例，--pool=threads）
npm run build      # tsc → dist/
```

## 数据模型要点（schema v2）

`transactions` 在基础字段外带四个账单溯源列（均 nullable，老数据可为空）：

| 列 | 含义 | 来源 |
| --- | --- | --- |
| `source` | alipay / wechat / manual / csv | 导入路径 |
| `externalId` | 平台交易单号 | 账单原件（手工录入无） |
| `paymentMethod` | 支付方式主渠道（零钱通/花呗/银行卡…，组合支付取 `&` 前段） | 账单原件 |
| `status` | 交易状态原文（交易成功/已全额退款…） | 账单原件 |

**去重**：有 `externalId` 时按 `(source, externalId)` 部分唯一索引精确去重，重复导入直接跳过；
无 externalId 退回四字段启发式（账户+金额+日期+商户）。

**自动分类决策顺序**：rules 规则（含收支方向闸门：规则指向分类的类型与流水类型不匹配即跳过）
→ 账单原件分类列映射（`bill/category-map.ts`）→ null（未分类）。

**余额不变量**：`accounts.balance == Σ(income) - Σ(expense)`（excluded/transfer 不计）；
任何批量改数脚本都必须复核该不变量。

## 运维脚本（`scripts/`，均为 dry-run + `--apply` 两段式）

| 脚本 | 用途 |
| --- | --- |
| `backfill-fields.ts` | 从账单原件回填 source/externalId/paymentMethod/status |
| `backfill-categories.ts` | 用账单分类列回填存量流水分类 |
| `apply-merchant-rules.ts` | 把审核过的商户→分类映射写入 rules 表并回填 |
| `verify-apply.ts` / `rule-risk.ts` | 回填后校验 / 规则回放风险评估 |
| `disable-short-rules.ts` | 禁用单字符 keyword 规则（includes 误伤防护） |
| `baseline.ts` / `snapshot-db.ts` | 改数前后指纹/快照对照 |

**安全规约**：账单解压密码一次性，**禁止**写入任何文件（默认值、注释、硬编码均不行），
只许命令行参数/环境变量传入；`bill/password-store.ts` 只做进程内存暂存。

## CLI 入口

```bash
npx tsx src/cli.ts --help
```
