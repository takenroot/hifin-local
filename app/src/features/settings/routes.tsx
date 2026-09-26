/**
 * 设置模块路由
 *  - /settings         设置中心（全页面 + 左侧菜单）
 *  - 子页通过 ?section=profile|preferences|security|ai|space|import|
 *                categories|rules|tags|merchants|about 切换。
 */
import type { RouteObject } from 'react-router-dom';
import SettingsPage from './SettingsPage';

const routes: RouteObject[] = [
  { path: 'settings', element: <SettingsPage /> },
];

export { routes };
export default routes;