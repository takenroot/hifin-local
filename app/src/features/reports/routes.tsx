/**
 * 报表模块路由
 *   - /report/list             列表
 *   - /report/detail/:id       详情
 */
import type { RouteObject } from 'react-router-dom';
import ReportList from './ReportList';
import ReportDetail from './ReportDetail';

const routes: RouteObject[] = [
  {
    path: 'report',
    children: [
      { index: true, element: <ReportList /> },
      { path: 'list', element: <ReportList /> },
      { path: 'detail/:id', element: <ReportDetail /> },
    ],
  },
];

export { routes };
export default routes;
