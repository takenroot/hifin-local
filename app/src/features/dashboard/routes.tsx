/**
 * 看板 Dashboard 模块路由
 * ---------------------------------------------------------------
 * 路由冲突说明：
 *   本模块提供的页面挂在路径 home 下，与阶段 1 已构建的
 *   src/features/home/Dashboard.tsx 骨架使用同一路径。
 *   App.tsx 通过 import.meta.glob 收集 src/features/<name>/routes.tsx，
 *   会同时收集到两个 path: home 路由，运行时可能造成重复匹配 /
 *   后注册路由覆盖先注册路由。集成阶段需决定：
 *     - 选项 A：保留本模块、删除 features/home 骨架；
 *     - 选项 B：保留 features/home 骨架、将本模块迁移到其他路径。
 *   本文件未修改 App.tsx，也未修改 features/home 骨架，
 *   冲突由集成阶段处理。
 * ---------------------------------------------------------------
 */
import type { RouteObject } from 'react-router-dom';
import Dashboard from './Dashboard';

const routes: RouteObject[] = [
  { path: 'home', element: <Dashboard /> },
];

export { routes };
export default routes;