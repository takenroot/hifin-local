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
- 流水：日/周/月/年分组（周一起始，分组头周期小计）+ 统计 Tab（月份翻页 + 分类饼图/排行）
- 看板收支日历：月份翻页（下界=最早交易月），与概览卡片月份独立
- 主题：浅色/暗黑/跟随系统；**收入=红色，支出=绿色**（用户直觉）
- 移动端 390px 全功能；通知弹窗（密码输入 + 重试计数）
- 数据全部来自 core 的 REST API：`useApi` 带模块级 SWR 缓存（二次访问首帧即显缓存、后台静默刷新），列表页空态全部 loading 门控零闪烁

### 后端（core/）
- **REST API**：accounts/transactions/categories/summary/goals/budgets/tags/merchants/rules/reports/spaces/kv/ai-models/notifications/bills（15 资源）
- **IMAP 轮询**：QQ 邮箱 → 检测账单邮件 → 支付宝直接下载附件 / 微信提取 URL 下载
- **账单解析**：ZIP 解密（adm-zip + ZipCrypto）→ GBK CSV 解码 / xlsx 转 CSV → parseCsvText → 事务入库 + 余额联动
- **账单溯源字段**：每笔流水带 source（alipay/wechat/manual/csv）、externalId（平台交易单号）、paymentMethod（支付方式主渠道）、status（交易状态原文）
- **确定性去重**：有 externalId 按 `(source, externalId)` 唯一索引精确去重，无则退回四字段启发式——重复导入同笔零风险
- **自动分类**：分类决策顺序 = rules 规则（含方向闸门）→ 账单原件分类列映射（category-map.ts）→ null
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
│   └── tests/                    # 105 例 Vitest（纯函数 + 分组/统计）
├── core/                         # Node 核心服务
│   ├── src/db/                   # SQLite schema v2/connection/migrate/seed
│   ├── src/routes/               # 15 个 REST 路由
│   ├── src/mail/                 # IMAP poller + 平台 parser + URL 提取
│   ├── src/bill/                 # ZIP 解压 + xlsx 转换 + 密码暂存 + 分类映射
│   ├── src/notifications/        # 通知 store + 状态机
│   ├── scripts/                  # 一次性运维脚本（回填/校验，dry-run + --apply）
│   └── tests/                    # 265 例 Vitest
├── docs/
│   ├── bill-automation-design.md # 账单自动化设计（Mermaid 图）
│   ├── known-issues.md           # 已知问题（ISSUE-001~004：URL 提取/Tailwind 缓存/ZipCrypto/规则引擎限制）
│   ├── agent-prompt-template.md  # subagent 派发模板
│   ├── acceptance-report.md      # R1-R4 验收报告（历史归档）
│   └── exploration-originals/    # 原版界面截图归档
├── accept/                       # 验收产物：scripts/ 回归脚本 + screenshots/ 产物 + archive/ 历史归档
├── hifin-features.md             # 原版功能清单（复刻源文档）
└── README.md / CHANGELOG.md
```

## 数据现状（2026-10-03）

- **账户**：现金 × 1（余额 -28,237.09；所有渠道汇总口径，含花呗负债）
- **交易**：817 笔（微信 500 + 支付宝 317，2025-12 至 2026-10 共 11 个月）
- **分类**：33 分类 + 4 标签（默认种子）；**808/817 已分类**（未分类仅 9 笔无法判断的商户）
- **规则**：226 条自动生成的商户分类规则（设置→规则可见可改，2 条单字符规则已禁用）
- **溯源**：817 笔全部带 source/externalId/paymentMethod/status（来自账单原件回填）
- **支付方式分布**：零钱通 275 / 花呗 311 / 零钱 90 / 工行卡 87+7 / 余额宝 82 / 中行卡 29（多账户拆分待决策）

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | React 18 + Vite + TS + Tailwind v3（darkMode:class）+ jotai + recharts |
| 后端 | Node 24 + TS + Express + better-sqlite3（WAL）+ imapflow + adm-zip + xlsx |
| 测试 | Vitest × 370 例（前端 105 + 后端 265）|
| 验收 | Playwright（`accept/scripts/` 8 个可复跑回归脚本，历史产物在 `accept/archive/`）|
| 部署 | GitHub Actions 无，纯本地 |

## 文档导航

- [CHANGELOG.md](./CHANGELOG.md) — 版本历史（R1-R8 + core P0-P1）
- [docs/bill-automation-design.md](./docs/bill-automation-design.md) — 账单自动化设计
- [docs/known-issues.md](./docs/known-issues.md) — 已知问题（ISSUE-001~004）
- [docs/agent-prompt-template.md](./docs/agent-prompt-template.md) — subagent 模板
- [docs/acceptance-report.md](./docs/acceptance-report.md) — R1-R4 验收报告（历史归档，数据通道叙述已过时）
- [core/README.md](./core/README.md) — core 子项目说明
- [app/README.md](./app/README.md) — app 子项目说明

## 许可

仅供学习。原版 [HiFin](https://app.hifin.ai) 归原作者。
