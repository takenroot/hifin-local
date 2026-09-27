# app

主应用 — Vite + React 18 + TypeScript + Tailwind v3。

## 脚本

```bash
npm run dev        # 开发服务（默认 http://127.0.0.1:5173）
npm run build      # tsc 类型检查 + Vite 产物构建
npm run preview    # 预览构建产物
npm run test       # Vitest 单元测试（52 例）
```

## 目录结构

```
src/
├── main.tsx                  入口（ThemeProvider > BrowserRouter > App）
├── App.tsx                   路由表：/ 重定向 + feature glob 自动收集
├── db.ts                     Dexie 数据库（v4，9 张表）
├── space.ts                  多空间过滤 helper（filterBySpace）
├── components/
│   └── ui/                   通用组件库（Button/Card/Modal/...）
├── layout/
│   ├── AppLayout.tsx         侧边栏 + 抽屉式主区 + 命令面板挂载
│   └── CommandPalette.tsx    命令面板占位（实际由 feature 提供）
├── store/
│   ├── atoms.ts              Jotai atoms（主题/语言/默认页/菜单显隐/空间）
│   └── theme.tsx             主题 Provider（light/dark/system + matchMedia）
└── features/                 功能模块（每个 module 一目录）
    ├── dashboard/            看板
    ├── accounts/             账户
    ├── transactions/         流水
    ├── goals/                目标
    ├── reports/              报表
    ├── budget/               预算
    ├── discover/             发现
    ├── settings/             设置
    ├── ai-assistant/         AI 助手
    └── command-palette/      ⌘K
```

## 数据模型

`db.ts` 中的 9 张表（Dexie v4）：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `spaces` | id, name, createdAt | 空间（多空间隔离） |
| `accounts` | id, name, type, balance, spaceId, ... | 账户 |
| `transactions` | id, type, amount, date, accountId, toAccountId, spaceId, ... | 流水 |
| `goals` | id, name, targetAmount, currentAmount, deadline, spaceId, ... | 目标 |
| `budgets` | id, name, categoryId?, amount, period, spaceId, ... | 预算 |
| `categories` | id, name, group, type, icon | 分类（全局，不分空间） |
| `tags` | id, name, color | 标签（全局） |
| `merchants` | id, name, remark | 商户（全局） |
| `rules` | id, keyword, matchField, categoryId, priority, enabled | 交易规则 |
| `reports` | id, name, template, config, ... | 报表 |
| `aiModels` | id, name, model, endpoint, apiKey | AI 模型 |
| `kv` | key, value | 杂项配置（昵称、用户 ID、默认页等） |

启动自动 seed 默认空间 + 33 个默认分类 + 4 个默认标签。

## 路由约定

- `App.tsx` 用 `import.meta.glob('./features/*/routes.tsx', { eager: true })` 自动收集
- 每个 feature 模块导出 `routes: RouteObject[]`，路径**不带前导 `/`**（相对 AppLayout 子路径）
- 新增 feature 无需改 `App.tsx`

## 多空间系统

```ts
import { useSpaceId } from '@/db';
import { filterBySpace } from '@/space';

const spaceId = useSpaceId();              // 0 表示"全部空间"
const accounts = useLiveQuery(
  () => db.accounts.toArray().then(r => filterBySpace(r, spaceId)),
  [spaceId],
);
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

`tests/` 下：

- `balance.test.ts` —— 流水余额联动
- `csv.test.ts` —— CSV 解析（支付宝/微信/通用）
- `dashboard-calc.test.ts` —— 看板计算（净资产/收支/分布/日历）
- `db-seed.test.ts` —— 数据库 seed 幂等

环境：`fake-indexeddb` 自动注入 Dexie 内存存储。

## 验收

构建后到仓库根目录用 `accept/scripts/` 下的 Playwright 脚本验证。详见 [`/accept/README.md`](../accept/README.md)。