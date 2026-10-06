/**
 * 视觉实验室路由 — 隐藏入口（/lab），不进侧边栏导航。
 * 看板复刻页供视觉想法试验，详见 ./DashboardLab.tsx 头注。
 */
import type { RouteObject } from 'react-router-dom';
import { DashboardLab } from './DashboardLab';

export const routes: RouteObject[] = [{ path: 'lab', element: <DashboardLab /> }];

export default routes;
