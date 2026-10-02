# app

主应用 — Vite + React 18 + TypeScript + Tailwind v3。

数据全部来自 core 的 REST API（`core/` 提供，SQLite 唯一数据源），浏览器端不落本地数据库。

## 脚本

```bash
npm run dev        # 开发服务（vite 默认 http://127.0.0.1:5173）
npm run build      # tsc 类型检查 + Vite 产物构建
npm run preview    # 预览构建产物
npm run test       # Vitest 单元测试（50 例）
```

> 端口说明：`vite.config.ts` 中 `server.port` 为 **5173**。本机多人/多 agent 并行预览时常被占用，实际使用中一般以 `npx vite --port <端口> --strictPort` 覆盖（例如 :5199）。接口不受影响——`/api` 由 vite proxy 转发到 core。

## 目录结构

```
src/
├── main.tsx                  入口（ThemeProvider > BrowserRouter > App）
├── App.tsx                   路由表：/ 重定向 + feature glob 自动收集
├── db.ts                     领域类型定义 + 空间 hook（无数据库实例）
├── space.ts                  多空间过滤 helper（filterBySpace）
├── components/
│   └── ui/                   通用组件库（Button/Card/Modal/...）
├── hooks/
│   └── useApi.ts             REST 数据 hook（useApi + apiFetch，共享契约）
├── layout/
│   ├── AppLayout.tsx         侧边栏 + 抽屉式主区 + 命令面板挂载
│   └── CommandPalette.tsx    命令面板占位（实际由 feature 提供）
├── store/
│   ├── atoms.ts              Jotai atoms（主题/语言/默认页/菜单显隐/空间）
│   └── theme.tsx             主题 Provider（light/dark/system + matchMedia）
└── features/                 功能模块（每个 module 一目录，共 12 个）
    ├── dashboard/            看板        → /home
    ├── accounts/             账户        → /account, /account/list, /account/detail/:id
    ├── transactions/         流水        → /transaction
    ├── goals/                目标        → /goal/list
    ├── reports/              报表        → /report, /report/list, /report/detail/:id
    ├── budget/               预算        → /budget
    ├── discover/             发现        → /discover
    ├── settings/             设置        → /settings
    ├── ai-assistant/         AI 助手     → /ai
    ├── command-palette/      ⌘K          → /command-palette
    ├── notifications/        通知中心（无 routes.tsx，由 AppLayout 挂载）
    └── rules/                规则引擎（无 routes.tsx，纯函数 engine.ts）
```

## 数据通道：REST + useApi

所有页面数据经 `/api/*` 从 core 取，**唯一数据源是 core 的 SQLite**。

```ts
import { useApi, apiFetch } from '@/hooks/useApi';

// 读
const { data, loading, error, refetch } = useApi<Account[]>('/api/accounts');
const txs = useApi<Transaction[]>(`/api/transactions?spaceId=${spaceId}`, [spaceId]);

// 写：apiFetch 统一错误处理，完成后手动 refetch()
await apiFetch('/api/accounts', 'POST', payload);
refetch();
```

- 读用 `useApi<T>(url, deps?)`：`url` 变化或调用 `refetch()` 时重新拉取；`url` 传 `null` 则不请求。
- 写用 `apiFetch<T>(url, method, body?)`：`POST` / `PUT` / `DELETE`，非 2xx 抛 `HTTP <status>: <body>`。
- 空间过滤直接拼 URL 查询参数（`?spaceId=1`），服务端负责过滤。
- 代理：`vite.config.ts` 把 `/api` 转发到 `http://localhost:8787`（core REST 服务）。

### core 提供的 REST 资源

`/api/` 下共 15 个资源：accounts、transactions、summary、categories、goals、budgets、tags、merchants、rules、reports、spaces、kv、ai-models、notifications、bills。详见 [core/README.md](../core/README.md)。

> `src/db.ts` 是**纯类型模块**（文件名是历史遗留）：它只导出 `Account` / `Transaction` / `Goal` / `TxRule` 等 TypeScript 类型、`DEFAULT_SPACE_ID` 常量，以及 `useSpaceId()`（读 Jotai atom 的空间选择 hook）。**它不持有任何数据库连接，也不做数据读写**——浏览器端已无本地数据库（IndexedDB 已废弃，依赖也已移除）。新代码需要领域类型时从它 `import type`，取数一律走上面的 `useApi` / `apiFetch`。

## 路由约定

- `App.tsx` 用 `import.meta.glob('./features/*/routes.tsx', { eager: true })` 自动收集
- 每个 feature 模块导出 `routes: RouteObject[]`，路径**不带前导 `/`**（相对 AppLayout 子路径）
- 新增 feature 无需改 `App.tsx`
- 无 `routes.tsx` 的 feature（如 `notifications/`、`rules/`）由父级布局或其他 feature 直接引用

## 多空间系统

```ts
import { useSpaceId } from '@/db';        // Jotai atom，不是数据库查询
import { filterBySpace } from '@/space';

const spaceId = useSpaceId();              // 0 表示"全部空间"
const { data } = useApi<Account[]>(`/api/accounts?spaceId=${spaceId}`, [spaceId]);
```

## 主题系统

```ts
const theme = useAtomValue(themeAtom);     // 'light' | 'dark' | 'system'
// theme==='system' 时由 ThemeProvider 监听 prefers-color-scheme 实时切换
```

## 暗黑模式样式约定

色板（`tailwind.config.js`）有 `DEFAULT` 与 `dark` 两套值。组件内统一用：

```tsx
<div className="text-text dark:text-text-dark bg-bg dark:bg-bg-dark border-border dark:border-border-dark">
```

已有标题专用类：`<h2 className="section-title">`（自动含 dark: 变体）。

## 单元测试

`tests/` 下共 50 例（4 个文件）：

- `balance.test.ts` —— 流水余额联动
- `csv.test.ts` —— CSV 解析（支付宝/微信/通用）
- `csv-real-statement.test.ts` —— 真实账单样本解析回归
- `dashboard-calc.test.ts` —— 看板计算（净资产/收支/分布/日历）

全部为纯计算用例，`tests/setup.ts` 已移除浏览器数据库垫片。运行：`npm run test`

## 验收

构建后到仓库根目录用 `accept/scripts/` 下的 Playwright 脚本验证。详见 [`/accept/README.md`](../accept/README.md)。
