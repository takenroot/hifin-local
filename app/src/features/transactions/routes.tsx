/**
 * 交易流水 feature 路由
 * ---------------------------------------------------------------
 * 阶段2 交付：
 *   - /transaction           列表 / 空状态
 *   - /transaction?create=1  自动打开新建模态
 *   - /transaction?import=1  默认展示批量导入视图
 */
import type { RouteObject } from 'react-router-dom';
import TransactionList from './TransactionList';

const routes: RouteObject[] = [
  { path: 'transaction', element: <TransactionList /> },
];

export { routes };
export default routes;
