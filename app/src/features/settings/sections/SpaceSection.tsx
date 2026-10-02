/**
 * 设置 → 当前空间 / 空间配置
 *
 * - 展示 spaceIdAtom 当前空间名（来自 GET /api/spaces，"全部空间"以 sid=0 表示）
 * - 多空间管理入口：可直接在侧边栏顶部"添加空间"完成创建；
 *   设置页只提供"当前空间"只读视图与说明，避免与侧边栏重复。
 */
import { useAtomValue } from 'jotai';
import { useMemo } from 'react';
import { Card, Spinner } from '@/components/ui';
import { useApi } from '@/hooks/useApi';
import { spaceIdAtom } from '@/store/atoms';
import type { Space } from '@/db';
import { toSpaces, type RestSpaceRow } from '../restApi';
import { ALL_SPACES_ID } from '@/space';

const ALL_SPACES_LABEL = '全部空间';

export function SpaceSection() {
  const spaceId = useAtomValue(spaceIdAtom);
  const { data, loading } = useApi<RestSpaceRow[]>('/api/spaces');
  // 迁移前是 orderBy('name')，这里按名称排序保持一致
  const spaces: Space[] = useMemo(
    () => toSpaces(data ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [data],
  );

  const label = (() => {
    if (spaceId === ALL_SPACES_ID) return ALL_SPACES_LABEL;
    return spaces.find((s) => s.id === spaceId)?.name ?? ALL_SPACES_LABEL;
  })();

  return (
    <div className="space-y-4">
      <Card
        title={
          <div>
            <div className="text-base font-medium">空间配置</div>
            <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
              多空间可独立隔离账户 / 流水 / 目标 / 预算
            </div>
          </div>
        }
      >
        <div className="space-y-3 max-w-[560px]">
          <div>
            <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">
              当前空间
            </label>
            <div className="h-10 px-3 rounded-xl border border-border dark:border-border-dark bg-bg dark:bg-bg-dark flex items-center text-sm">
              {label}
            </div>
            <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
              切换空间请使用侧边栏顶部空间切换器；选择"全部空间"则不过滤。
            </div>
          </div>

          <div>
            <div className="text-xs text-text-muted dark:text-text-muted-dark mb-1.5">已有空间（{spaces.length}）</div>
            <ul className="divide-y divide-border dark:divide-border-dark rounded-xl border border-border dark:border-border-dark overflow-hidden">
              <li className="flex items-center justify-between px-3 py-2 text-sm bg-bg dark:bg-bg-dark">
                <span>全部空间</span>
                <span className="text-xs text-text-muted dark:text-text-muted-dark">不过滤</span>
              </li>
              {spaces.map((s) => (
                <li
                  key={s.id ?? s.name}
                  className="flex items-center justify-between px-3 py-2 text-sm"
                >
                  <span className="truncate">{s.name}</span>
                  <span className="text-xs text-text-muted dark:text-text-muted-dark">
                    {s.id != null ? `id ${s.id}` : ''}
                  </span>
                </li>
              ))}
              {loading ? (
                // 加载中先占位，别先闪一行"（暂无空间…）"
                <li className="px-3 py-2 flex items-center">
                  <Spinner size={14} />
                </li>
              ) : (
                spaces.length === 0 && (
                  <li className="px-3 py-2 text-xs text-text-muted dark:text-text-muted-dark">
                    （暂无空间，请通过侧边栏顶部"添加空间"创建）
                  </li>
                )
              )}
            </ul>
          </div>

          <div className="text-xs text-text-muted dark:text-text-muted-dark">
            空间切换 / 创建 / 删除均在侧边栏顶部完成；本设置页仅展示当前状态。
          </div>
        </div>
      </Card>
    </div>
  );
}