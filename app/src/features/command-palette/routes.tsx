/**
 * 命令面板模块路由
 *
 * 命令面板本身是一个全局浮层（挂在 AppLayout），并非独立页面。
 * 为兼容 features/* 自动收集约定，这里提供一个空路由占位：
 * 访问 /command-palette 时跳回 /home，但浮层仍由 AppLayout 内核控制。
 */
import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';

const routes: RouteObject[] = [
  { path: 'command-palette', element: <Navigate to="/home" replace /> },
];

export { routes };
export default routes;