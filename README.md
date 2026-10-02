# HiFin 本地复刻 + AI 财务自动化工具

个人财务管理工具的本地化版本 + **自动化账单接入引擎**。

原版 [app.hifin.ai](https://app.hifin.ai) 是云端财务应用。本项目：
1. **1:1 复刻**原版界面与功能（浏览器 SPA）
2. **激进迁移**到本地 SQLite（IndexedDB 已废弃，REST 为唯一数据通道）
3. **扩展自动化**：IMAP 邮件轮询 → 自动识别账单 → 解压 → 解析 → 入库 → 通知

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                    hifin-core (Node 常驻)                     │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────────────┐  │
│  │ IMAP    │ │ REST    │ │ 账单    │ │ 通知引擎        │  │
│  │ 轮询器  │ │ API     │ │ 解压器  │ │ (密码重试状态机)│  │
│  │         │ │ 15资源  │ │ GBK/xlsx│ │                 │  │
│  └─────────┘ └─────────┘ └─────────┘ └─────────────────┘  │
│         ↑ SQLite (唯一数据源, WAL)                           │
└─────────┬───────────────────────────────────────────────────┘
          │ REST /api/*
    ┌─────┴─────┐
    ↓           ↓
┌───────┐  ┌───────┐
│ Web   │  │ CLI   │
│ SPA   │  │(AI用) │
└───────┘  └───────┘
```

## 核心特性

### 前端（app/）
- 看板/账户/交易/目标/报表/预算/发现/设置/AI助手/⌘K 命令面板/通知中心/规则引擎（`app/src/features/` 下 12 个模块）
- 主题：浅色/暗黑/跟随系统；**收入=红色，支出=绿色**（用户直觉）
- 移动端 390px 全功能；通知弹窗（密码输入 + 重试计数）
- 数据全部来自 core 的 REST API（`useApi` / `apiFetch`），IndexedDB 已废弃、浏览器端零本地数据库

### 后端（core/）
- **REST API**：accounts/transactions/categories/summary/goals/budgets/tags/merchants/rules/reports/spaces/kv/ai-models/notifications/bills（15 资源）
- **IMAP 轮询**：QQ 邮箱 → 检测账单邮件 → 支付宝直接下载附件 / 微信提取 URL 下载
- **账单解析**：ZIP 解密（adm-zip + ZipCrypto）→ GBK CSV 解码 / xlsx 转 CSV → parseCsvText → 事务入库 + 余额联动
- **通知系统**：need_password → 用户提交 → 3 次重试 → failed 降级
- **CLI**：`hifin serve/accounts/tx/summary/import-csv/import-bill/mail config/mail poll`

## 快速开始

```bash
# 1. 启动 core（REST + SQLite）
cd core && npm install && npx tsx src/server.ts   # :8787

# 2. 启动前端（vite proxy → core）
cd app && npm install && npm run dev              # :5173
```

> 前端端口：vite 默认 **5173**；本机实际预览常用 `--port 5199` 覆盖（`npx vite --port 5199 --strictPort`），避免与默认端口占用冲突。`/api` 始终 proxy 到 core 的 :8787。

```bash
# 3. 配置邮箱（IMAP 授权码）
cd core
npx tsx src/cli.ts mail config --host imap.qq.com --port 993 \
  --user xxx@qq.com --password <授权码> --tls true

# 4. 手动导入账单 ZIP
npx tsx src/cli.ts import-bill ~/Downloads/账单.zip \
  --platform alipay|wechat --password <一次性密码> --accountId 1

# 5. 或自动轮询（检测到新账单邮件时自动下载导入）
npx tsx src/cli.ts mail poll --days 7 --accountId 1 \
  --bill-password-alipay <密码> --bill-password-wechat <密码>
```

## 项目结构

```
hifin/
├── app/                          # Web SPA（Vite+React18+TS+Tailwind）
│   ├── src/features/             # 12 个功能模块（REST 已切换）
│   ├── src/hooks/useApi.ts       # useApi + apiFetch（共享契约）
│   └── tests/                    # 50 例 Vitest
├── core/                         # Node 核心服务
│   ├── src/db/                   # SQLite schema/connection/migrate/seed
│   ├── src/routes/               # 15 个 REST 路由
│   ├── src/mail/                 # IMAP poller + 平台 parser + URL 提取
│   ├── src/bill/                 # ZIP 解压 + xlsx 转换 + 密码暂存
│   ├── src/notifications/        # 通知 store + 状态机
│   └── tests/                    # 148 例 Vitest
├── docs/
│   ├── bill-automation-design.md # 账单自动化设计（Mermaid 图）
│   ├── known-issues.md           # 已知问题（URL 提取、Tailwind 缓存）
│   ├── agent-prompt-template.md  # subagent 派发模板
│   ├── acceptance-report.md      # R1-R4 验收报告（历史归档）
│   └── exploration-originals/    # 原版界面截图归档
├── accept/                       # 验收产物：scripts/ 回归脚本 + screenshots/ 产物 + archive/ 历史归档
├── hifin-features.md             # 原版功能清单（复刻源文档）
└── README.md / CHANGELOG.md
```

## 数据现状（2026-10-02）

- **账户**：现金 × 1（余额 -19,505.22）
- **交易**：500 笔（全部来自微信账单导入，2025-12 至 2026-10）
- **分类/标签**：33 分类 + 4 标签（默认种子）
- **支付宝数据**：已清空（测试数据清理后未重新导入）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + TS + Tailwind v3（darkMode:class）+ jotai + recharts |
| 后端 | Node 24 + TS + Express + better-sqlite3（WAL）+ imapflow + adm-zip + xlsx |
| 测试 | Vitest × 198 例（前端 50 + 后端 148）|
| 验收 | Playwright（`accept/scripts/` 4 个可复跑回归脚本，历史产物在 `accept/archive/`）|
| 部署 | GitHub Actions 无，纯本地 |

## 文档导航

- [CHANGELOG.md](./CHANGELOG.md) — 版本历史（R1-R8 + core P0-P1）
- [docs/bill-automation-design.md](./docs/bill-automation-design.md) — 账单自动化设计
- [docs/known-issues.md](./docs/known-issues.md) — 已知问题
- [docs/agent-prompt-template.md](./docs/agent-prompt-template.md) — subagent 模板
- [docs/acceptance-report.md](./docs/acceptance-report.md) — R1-R4 验收报告（历史归档，数据通道叙述已过时）
- [core/README.md](./core/README.md) — core 子项目说明
- [app/README.md](./app/README.md) — app 子项目说明

## 许可

仅供学习。原版 [HiFin](https://app.hifin.ai) 归原作者。
