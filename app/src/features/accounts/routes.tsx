/**
 * 账户模块路由
 * - /account/list        列表
 * - /account/detail/:id  详情
 */
import type { RouteObject } from 'react-router-dom';
import AccountList from './AccountList';
import AccountDetail from './AccountDetail';

const routes: RouteObject[] = [
  {
    path: 'account',
    children: [
      { index: true, element: <AccountList /> },
      { path: 'list', element: <AccountList /> },
      { path: 'detail/:id', element: <AccountDetail /> },
    ],
  },
];

export { routes };
export default routes;
