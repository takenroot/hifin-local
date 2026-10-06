import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes, useLocation, useRoutes } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import { AppLayout } from '@/layout';
import { defaultPageAtom } from '@/store/atoms';

/**
 * Feature 路由注册（路由级代码分割）
 * ---------------------------------------------------------------
 * 每个 feature 模块位于 src/features/<name>/，必须 export const routes: RouteObject[]
 * （从 'react-router-dom' 导入 RouteObject 类型）。
 *
 * 这里用 Vite 的 import.meta.glob 收集所有 ./features/<name>/routes.tsx 的
 * 动态 import，再用 React.lazy 为每个 feature 创建一个懒加载组件。首屏只
 * 下载当前路径对应的 feature chunk，其余 feature 在首次访问时才加载。
 *
 * 新增 feature 时：
 *   1. 在 src/features/<name>/ 下新建 routes.tsx，export const routes: RouteObject[]
 *   2. 在下方 FEATURE_MODULES 中补一条 import() 映射
 *   3. 在 FEATURE_PREFIXES 中补一条路径前缀映射
 * ---------------------------------------------------------------
 */

type FeatureRoutesModule = { routes: RouteObject[] };

/** 路径前缀 → 动态 import 的映射（保持各 feature 的 useRoutes 相对路径解析不变） */
const FEATURE_MODULES: Record<string, () => Promise<FeatureRoutesModule>> = {
  accounts: () => import('./features/accounts/routes'),
  aiAssistant: () => import('./features/ai-assistant/routes'),
  budget: () => import('./features/budget/routes'),
  commandPalette: () => import('./features/command-palette/routes'),
  dashboard: () => import('./features/dashboard/routes'),
  discover: () => import('./features/discover/routes'),
  goals: () => import('./features/goals/routes'),
  lab: () => import('./features/lab/routes'),
  reports: () => import('./features/reports/routes'),
  settings: () => import('./features/settings/routes'),
  transactions: () => import('./features/transactions/routes'),
};

/** URL 第一段 → feature key。FeatureRoutes 据此挑选要渲染的懒加载组件 */
const FEATURE_PREFIXES: Array<[string, string]> = [
  ['account', 'accounts'],
  ['ai', 'aiAssistant'],
  ['budget', 'budget'],
  ['command-palette', 'commandPalette'],
  ['home', 'dashboard'],
  ['discover', 'discover'],
  ['goal', 'goals'],
  ['lab', 'lab'],
  ['report', 'reports'],
  ['settings', 'settings'],
  ['transaction', 'transactions'],
];

/** 为每个 feature 创建 React.lazy 包装组件；加载完成后用 useRoutes 渲染其 routes */
const LAZY_FEATURES: Record<string, React.LazyExoticComponent<React.ComponentType>> =
  Object.fromEntries(
    Object.entries(FEATURE_MODULES).map(([key, loader]) => {
      const Lazy = lazy(async () => {
        const mod = await loader();
        return { default: () => useRoutes(mod.routes) };
      });
      return [key, Lazy];
    }),
  );

/** 路由级 Suspense fallback：与页面内 loading 态一致的脉冲骨架，避免空态闪烁 */
function RouteSkeleton() {
  return (
    <div className="flex-1 min-w-0 space-y-6" data-testid="route-skeleton">
      <div className="h-24 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-16 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
        ))}
      </div>
    </div>
  );
}

function FeatureRoutes() {
  const { pathname } = useLocation();
  const seg = pathname.split('/')[1];
  const match = FEATURE_PREFIXES.find(([prefix]) => prefix === seg);
  if (!match) return null;
  const Component = LAZY_FEATURES[match[1]];
  return (
    <Suspense fallback={<RouteSkeleton />}>
      <Component />
    </Suspense>
  );
}

/**
 * 根据 defaultPageAtom 解析默认页的目标路由。
 * 合法值：home | account | transaction | goal | report
 * 兜底：'/home'。
 */
function resolveDefaultPath(defaultPage: string | undefined): string {
  switch (defaultPage) {
    case 'account':
      return '/account/list';
    case 'transaction':
      return '/transaction';
    case 'goal':
      return '/goal/list';
    case 'report':
      return '/report/list';
    case 'home':
    default:
      return '/home';
  }
}

function RootIndexRedirect() {
  const defaultPage = useAtomValue(defaultPageAtom);
  return <Navigate to={resolveDefaultPath(defaultPage)} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<RootIndexRedirect />} />
        {/* feature routes mounted via lazy FeatureRoutes for code splitting */}
        <Route path="*" element={<FeatureRoutes />} />
      </Route>
    </Routes>
  );
}
