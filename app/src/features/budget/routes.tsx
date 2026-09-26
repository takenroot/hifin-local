/**
 * 预算模块路由
 *   - /budget   列表（首页 / 空状态 + 卡片）
 */
import type { RouteObject } from 'react-router-dom';
import BudgetList from './BudgetList';

const routes: RouteObject[] = [
  { path: 'budget', element: <BudgetList /> },
];

export { routes };
export default routes;