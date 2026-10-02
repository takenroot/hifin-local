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
npm run test       # vitest（148 例）
npm run build      # tsc → dist/
```

## CLI 入口

```bash
npx tsx src/cli.ts --help
```
