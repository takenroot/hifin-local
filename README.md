# HiFin 本地复刻

个人财务管理工具的本地化版本 —— 完全跑在浏览器，数据存在 IndexedDB，**无任何云端依赖**。

原版 [app.hifin.ai](https://app.hifin.ai) 是一个云端财务应用。本仓库基于公开访问的界面（功能清单见 [`hifin-features.md`](./hifin-features.md)）进行 1:1 复刻并扩展本地化能力。

## 特性

- 🏠 **看板**：净资产/收支三卡、趋势图、分布环图、收支日历
- 💳 **账户**：两步创建、列表/详情、与流水联动
- 🔁 **交易流水**：四类（支出/收入/转账/不计收支）、余额联动、CSV 批量导入（支付宝/微信/通用银行）
- 🎯 **目标**：两步创建、进度条、快捷存入/取出
- 📊 **报表**：4 个内置模板 + 自定义数据范围/组件组合
- 💰 **预算**：月度/年度预算、按分类聚合、超支预警
- 🔍 **发现**：本地数据洞察（储蓄率/连续记账/超支提醒/临期目标）
- ⚡ **交易规则**：按关键词自动归类流水
- 🤖 **AI 助手**：本地接入 OpenAI 兼容端点（默认关闭）
- ⌘K **命令面板**：搜索 + 快捷操作（新建流水 t / 新建账户 n / 新建分类 c / AI 助手 a）
- 🏢 **多空间**：数据按空间隔离，可创建/切换/全部空间
- 🌤️ **天气**：基于 Open-Meteo，看板欢迎区实时显示
- 🎨 **主题**：浅色/暗黑/跟随系统三种模式
- 📱 **移动端**：390px 起全功能可用，抽屉式侧边栏

## 快速开始

```bash
cd app
npm install
npm run dev        # 开发服务，默认 http://127.0.0.1:5173
npm run build      # 生产构建（含 tsc 类型检查）
npm run test       # 单元测试（Vitest）
```

第一次运行会自动 seed 默认分类（33 项）和默认标签。

## 项目结构

```
hifin/
├── app/                              # 主应用（Vite + React + TS）
│   ├── src/
│   │   ├── components/ui/            # 通用组件库（Tailwind 实现）
│   │   ├── features/                 # 功能模块（自动路由注册）
│   │   │   ├── dashboard/            # 看板
│   │   │   ├── accounts/             # 账户
│   │   │   ├── transactions/         # 交易流水
│   │   │   ├── goals/                # 目标
│   │   │   ├── reports/              # 报表
│   │   │   ├── budget/               # 预算
│   │   │   ├── discover/             # 发现
│   │   │   ├── settings/             # 设置
│   │   │   ├── ai-assistant/         # AI 助手
│   │   │   └── command-palette/      # ⌘K
│   │   ├── layout/                   # 全局布局（侧边栏/抽屉）
│   │   ├── store/                    # Jotai atoms
│   │   ├── db.ts                     # Dexie 数据库（v4，9 张表）
│   │   └── space.ts                  # 多空间过滤 helper
│   ├── tests/                        # Vitest 单元测试（52 例）
│   └── package.json
├── docs/
│   ├── exploration-originals/         # 原版界面截图（归档，仅供对照）
│   └── acceptance-report.md          # 验收报告（第二轮 R1-R3）
├── accept/                           # 验收产物
│   ├── scripts/                      # Playwright E2E 脚本
│   └── screenshots/                  # 截图（按类型分目录）
├── hifin-features.md                 # 项目缘起：原版功能清单（最重要文档）
├── README.md                         # 你正在看
├── CHANGELOG.md                      # 版本变更日志
└── package.json                      # 仅供 accept/scripts 使用 Playwright
```

## 技术栈

| 层 | 选型 |
|---|---|
| 构建 | Vite 5 + TypeScript 5 |
| UI | React 18 + Tailwind CSS v3（darkMode: class） |
| 路由 | react-router-dom v6（`import.meta.glob` 自动收集 feature 模块） |
| 数据 | Dexie 4（IndexedDB） + dexie-react-hooks |
| 状态 | Jotai（atomWithStorage 持久化偏好） |
| 图表 | Recharts |
| 图标 | @tabler/icons-react |
| 日期 | dayjs |
| 测试 | Vitest + fake-indexeddb（52 例） |
| 验收 | Playwright（仅脚本在 `accept/scripts/`，浏览器需自装） |

## 文档导航

- [`hifin-features.md`](./hifin-features.md) —— 原版功能清单（复刻的源文档）
- [`CHANGELOG.md`](./CHANGELOG.md) —— 版本变更日志（按 git 提交）
- [`docs/acceptance-report.md`](./docs/acceptance-report.md) —— 第二轮验收报告（R1-R3）
- [`app/README.md`](./app/README.md) —— app 子项目：脚本/架构/约定
- [`accept/README.md`](./accept/README.md) —— 验收产物说明

## 开发约定

### 新增功能模块
在 `app/src/features/<name>/` 下创建 `routes.tsx`：
```ts
import type { RouteObject } from 'react-router-dom';
const routes: RouteObject[] = [{ path: 'your-path', element: <YourPage /> }];
export { routes };
```
路由会被 `import.meta.glob` 自动收集，**不需要改 App.tsx**。

### 数据模型变更
修改 `app/src/db.ts`，递增 Dexie version（v4 当前）。Dexie 增量迁移，新字段可加但需在迁移块里赋默认值（参考 `ensureSeed` 与 `migrateLegacySpaceIds`）。

### 按空间过滤
所有功能模块通过 `useSpaceId()`（来自 `db.ts`）+ `filterBySpace(rows, spaceId)`（来自 `space.ts`）过滤数据。`spaceId === 0` 表示"全部空间"。

### 暗黑模式
必须写全 `dark:` 变体。色板约定：`text-text dark:text-text-dark`；`bg-bg dark:bg-bg-dark`；`border-border dark:border-border-dark`。所有 token 在 `app/tailwind.config.js`。

## 不做（明确划界）

按 [`hifin-features.md`](./hifin-features.md) 第十二章约定：

- 云端同步 / 登录 / 多设备管理
- 会员 / 分享
- 原版的智谱 GLM 云端 AI（已由本地方案替代）
- i18n 全量翻译（仅主题/默认页生效，语言切换为占位）

## 施工与验收

本项目由调度方（kimi-coding → minimax）协调多个 M3 agent 通过 workflow 工具分批迭代完成，每轮由调度方独立验收：

- R1 脚手架 + 5 模块并行（受订阅并发上限 3-4 影响）
- R2 限流分批 3+2 + 失败重试
- R3 验收返修：⌘K 全局监听 / 用户 ID 生成
- R4 验收返修：暗黑模式对比度
- R5 迭代：预算 / 交易规则 / AI 助手 / 单测 / 代码分割
- R6 迭代：主题跟随系统 / 多空间隔离 / 报表自定义 / 移动端 / 发现页 / 天气

详细变更见 [`CHANGELOG.md`](./CHANGELOG.md)。

## 许可

仅供学习与个人使用。原版 [HiFin](https://app.hifin.ai) 归原作者所有。