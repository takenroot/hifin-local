/**
 * 空状态引导卡片
 * ---------------------------------------------------------------
 * 列表页空状态的统一容器：
 * - Card 提供 rounded-2xl + shadow-soft + border 的设计系统外观
 * - EmptyState 居中排版（py-16 + 插画 + 标题 + 描述 + 引导按钮）
 * - max-w-2xl + mx-auto 让卡片居中且不撑满内容宽度，避免宽屏下
 *   空状态元素被拉得过散。
 */
import { Card } from './Card';
import { EmptyState, type EmptyStateProps } from './EmptyState';

export function EmptyStateCard(props: EmptyStateProps) {
  return (
    <div className="max-w-2xl mx-auto">
      <Card>
        <EmptyState {...props} />
      </Card>
    </div>
  );
}
