import { useEffect } from 'react';
import { Navigate, Route, Routes, useRoutes } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import { useAtomValue } from 'jotai';
import { AppLayout } from '@/layout';
import { ensureSeed } from '@/db';
import { defaultPageAtom } from '@/store/atoms';

/**
 * Feature 路由自动注册
 * ---------------------------------------------------------------
 * 每个 feature 模块位于 src/features/<name>/，必须 export const routes: RouteObject[]
 * （从 'react-router-dom' 导入 RouteObject 类型）。
 *
 * 这里用 Vite 的 import.meta.glob 一次性收集所有 ./features/<name>/routes.tsx，
 * 再合并进 AppLayout 子路由树，从而避免每加一个 feature 都修改 App.tsx。
 *
 * 新增 feature 时：
 *   1. 在 src/features/<name>/ 下新建 routes.tsx，export const routes: RouteObject[]
 *   2. 不要在本文件添加任何引用；自动发现会处理。
 * ---------------------------------------------------------------
 */
const featureRouteModules = import.meta.glob<{ routes: RouteObject[] }>(
  './features/*/routes.tsx',
  { eager: true },
);

const featureRoutes: RouteObject[] = Object.values(featureRouteModules).flatMap(
  (mod) => mod.routes ?? [],
);

function FeatureRoutes() {
  return useRoutes(featureRoutes);
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
  useEffect(() => {
    // 应用启动时确保默认数据已 seed
    void ensureSeed();
  }, []);

  return (
    <Routes>
      <Route path="/" element={<AppLayout />}>
        <Route index element={<RootIndexRedirect />} />
        {/* feature routes mounted via useRoutes for dynamic discovery */}
        <Route path="*" element={<FeatureRoutes />} />
      </Route>
    </Routes>
  );
}