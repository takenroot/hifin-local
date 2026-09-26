# Feature 模块约定

HiFin 采用"按 feature 垂直切分"的组织方式，每个 feature 是一个自包含的目录。

## 目录结构

```
src/features/
├── home/                ← 看板 /home
│   ├── routes.tsx
│   ├── Dashboard.tsx
│   └── ...
├── account/             ← 账户 /account/list, /account/detail/:id
├── transaction/         ← 交易 /transaction
├── goal/                ← 目标 /goal/list, /goal/detail/:id
├── report/              ← 报表 /report/list
└── settings/            ← 设置 /settings（含偏好 / AI / 分类 / 标签 / 商户）
```

## 必备导出：routes.tsx

每个 feature 必须提供 `routes.tsx`，并 export 一份 `RouteObject[]`：

```tsx
// src/features/account/routes.tsx
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

## 文件约束

- 每个 feature **只能在自己的目录内**创建 / 修改文件。
- 不允许跨 feature 直接 import 页面组件；共享代码请放到 `src/components/` 或 `src/store/`。
- feature 内部需要的 UI 组件，优先使用 `src/components/ui/`。
- feature 内部需要的数据访问直接 `import { db } from '@/db'`，并使用 `dexie-react-hooks` 的 `useLiveQuery`。

## 共享资源

| 资源 | 路径 | 用途 |
| --- | --- | --- |
| Dexie 数据库 | `src/db.ts` | 表、接口、seed |
| Jotai atoms | `src/store/atoms.ts` | 主题、语言、菜单显隐、空间等偏好 |
| 通用 UI 组件 | `src/components/ui/` | Button、Card、Modal、Tabs、EmptyState… |
| 布局 | `src/layout/AppLayout.tsx` | 侧边栏 + 主内容区 |

## 开发流程

1. 在 `src/features/<your-feature>/` 下创建目录。
2. 实现组件，再在 `routes.tsx` 里登记路由。
3. 启动 `npm run dev` 后即可访问对应路由。
4. 不要运行完整 `npm run build`（其他模块可能未就绪），但**必须**保证本目录 `npx tsc --noEmit` 无错误。
