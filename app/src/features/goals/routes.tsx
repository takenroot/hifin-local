/**
 * 目标模块路由
 *   - /goal/list   列表（首页 / 空状态 + 卡片）
 */
import type { RouteObject } from 'react-router-dom';
import GoalList from './GoalList';

const routes: RouteObject[] = [
  { path: 'goal/list', element: <GoalList /> },
];

export { routes };
export default routes;
