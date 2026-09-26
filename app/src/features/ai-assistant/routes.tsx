/**
 * AI 助手模块路由
 *   - /ai   聊天页（默认关闭，模型未配置时显示引导）
 */
import type { RouteObject } from 'react-router-dom';
import AssistantPage from './AssistantPage';

const routes: RouteObject[] = [
  { path: 'ai', element: <AssistantPage /> },
];

export { routes };
export default routes;