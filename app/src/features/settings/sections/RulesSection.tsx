/**
 * 设置 → 交易规则（占位页）
 */
import { IconFileText } from '@tabler/icons-react';
import { Card } from '@/components/ui';

export function RulesSection() {
  return (
    <Card
      title={
        <div>
          <div className="text-base font-medium">交易规则</div>
          <div className="text-xs text-text-muted mt-1">
            使用规则自动归类、标记流水
          </div>
        </div>
      }
    >
      <div className="py-8 text-center text-text-muted">
        <IconFileText size={32} className="mx-auto mb-3 opacity-60" />
        <div className="text-sm">交易规则占位功能，敬请期待。</div>
        <div className="text-xs mt-2">
          计划支持：按商户/关键词自动分类、自动打标签、批量改写备注。
        </div>
      </div>
    </Card>
  );
}