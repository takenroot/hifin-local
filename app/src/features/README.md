# Feature 模块约定

HiFin 采用"按 feature 垂直切分"的组织方式，每个 feature 是一个自包含的目录。

## 目录结构

`src/features/` 下共 12 个模块：

| 目录 | 路由 | 说明 |
| --- | --- | --- |
| `dashboard/` | `/home` | 看板：资产概览/趋势/分布/日历 |
| `accounts/` | `/account`、`/account/list`、`/account/detail/:id` | 账户列表与详情 |
| `transactions/` | `/transaction` | 流水、CSV / 账单导入 |
| `goals/` | `/goal/list` | 目标管理 |
| `reports/` | `/report`、`/report/list`、`/report/detail/:id` | 报表 |
| `budget/` | `/budget` | 预算 |
| `discover/` | `/discover` | 本地数据洞察 |
| `settings/` | `/settings` | 偏好 / AI / 分类 / 标签 / 商户 / 安全 |
| `ai-assistant/` | `/ai` | AI 助手（OpenAI 兼容端点） |
| `command-palette/` | `/command-palette` | ⌘K 命令面板 |
| `notifications/` | — | 通知中心，**无 routes.tsx**，由 `layout/AppLayout.tsx` 挂载 |
| `rules/` | — | 规则匹配纯函数 `engine.ts`，**无 routes.tsx**，被 transactions 等调用 |

## 必备导出：routes.tsx

需要出现在路由表里的 feature 必须提供 `routes.tsx`，并 export 一份 `RouteObject[]`：

```tsx
// src/features/accounts/routes.tsx
import type { RouteObject } from 'react-router-dom';

const routes: RouteObject[] = [
  { path: 'account', children: [
      { index: true, element: <AccountList /> },
      { path: 'list', element: <AccountList /> },
      { path: 'detail/:id', element: <AccountDetail /> },
  ]},
];

export { routes };
export default routes;
```

`App.tsx` 通过 `import.meta.glob('./features/*/routes.tsx', { eager: true })` 收集所有 `routes`，再合并到 `AppLayout` 的子路由下。因此**新增 feature 时不需要修改 `App.tsx`**。

纯逻辑模块（如 `rules/`）或由布局直接挂载的模块（如 `notifications/`）可以不提供 `routes.tsx`。

## 文件约束

- 每个 feature **只能在自己的目录内**创建 / 修改文件。
- 不允许跨 feature 直接 import 页面组件；共享代码请放到 `src/components/` 或 `src/store/`。
- feature 内部需要的 UI 组件，优先使用 `src/components/ui/`。

## 数据访问约定

**所有数据读写一律通过 `useApi` / `apiFetch` 走 REST `/api/*`，禁止直接 `import db` 做数据读写。**

```ts
import { useApi, apiFetch } from '@/hooks/useApi';

const { data, loading, error, refetch } = useApi<Transaction[]>('/api/transactions');
await apiFetch('/api/transactions', 'POST', payload);
refetch();
```

- 唯一数据源是 core 的 SQLite；浏览器端不落本地数据库（IndexedDB / Dexie 已废弃）。
- 需要空间过滤时直接把 `?spaceId=<id>` 拼进 URL，由服务端过滤。
- 写操作后手动 `refetch()` 刷新对应 `useApi`。
- `import { type Account, ... } from '@/db'` **只允许用于取类型**；`@/db` 不得作为数据来源使用。

## 共享资源

| 资源 | 路径 | 用途 |
| --- | --- | --- |
| REST 数据层 | `src/hooks/useApi.ts` | `useApi`（读）/ `apiFetch`（写） |
| 数据类型 | `src/db.ts` | 领域接口类型（`Account` / `Transaction` / ...）；**仅类型，无数据访问** |
| 多空间 helper | `src/space.ts` | `filterBySpace` / `belongsToSpace` 纯函数 |
| Jotai atoms | `src/store/atoms.ts` | 主题、语言、菜单显隐、空间等偏好 |
| 通用 UI 组件 | `src/components/ui/` | Button、Card、Modal、Tabs、EmptyState… |
| 布局 | `src/layout/AppLayout.tsx` | 侧边栏 + 主内容区 |

## 开发流程

1. 在 `src/features/<your-feature>/` 下创建目录。
2. 实现组件，再在 `routes.tsx` 里登记路由。
3. 启动 `npm run dev` 后即可访问对应路由（vite 默认 :5173；端口被占用时用 `npx vite --port <端口> --strictPort` 覆盖）。
4. 不要运行完整 `npm run build`（其他模块可能未就绪），但**必须**保证本目录 `npx tsc --noEmit` 无错误。
