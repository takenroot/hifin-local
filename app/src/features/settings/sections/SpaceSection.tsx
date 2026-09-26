/**
 * 设置 → 当前空间 / 空间配置
 *
 * - 展示 spaceAtom 当前空间名
 * - 其他高级配置项（多空间管理 / 同步）当前未启用，给出占位说明。
 */
import { useAtomValue } from 'jotai';
import { Card, Input } from '@/components/ui';
import { spaceAtom } from '@/store/atoms';

export function SpaceSection() {
  const space = useAtomValue(spaceAtom);
  return (
    <div className="space-y-4">
      <Card
      title={
        <div>
          <div className="text-base font-medium">空间配置</div>
          <div className="text-xs text-text-muted mt-1">
            管理当前空间的名称与基础信息
          </div>
        </div>
      }
    >
        <div className="space-y-3 max-w-[560px]">
          <div>
            <label className="block text-xs text-text-muted mb-1.5">
              当前空间
            </label>
            <Input value={space} readOnly />
            <div className="mt-1 text-xs text-text-muted">
              空间名可在侧边栏顶部切换。该字段在本地持久化（localStorage）。
            </div>
          </div>
          <div className="text-xs text-text-muted">
            多空间管理 / 跨空间合并 / 空间导入 暂为占位功能，本地复刻版仅保留单一空间。
          </div>
        </div>
      </Card>
    </div>
  );
}