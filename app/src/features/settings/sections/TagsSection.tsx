/**
 * 设置 → 标签管理
 *
 * tags 表 CRUD：名称 + 颜色圆点
 */
import { useEffect, useMemo, useState } from 'react';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconTag,
} from '@tabler/icons-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
} from '@/components/ui';
import { apiFetch, useApi } from '@/hooks/useApi';
import type { Tag } from '@/db';
import { restDelete, toTags, type RestTagRow } from '../restApi';

const COLOR_OPTIONS = [
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#6b7280',
  '#14b8a6',
  '#f97316',
];

export function TagsSection() {
  const { data, loading, refetch } = useApi<RestTagRow[]>('/api/tags');
  const tags = useMemo(
    () => toTags(data ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [data],
  );
  const [editing, setEditing] = useState<Tag | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Tag | null>(null);

  const isEmpty = !loading && tags.length === 0;

  return (
    <Card
      title={
        <div>
          <div className="text-base font-medium">标签管理</div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
            自定义标签，方便管理数据
          </div>
        </div>
      }
      extra={!isEmpty && (
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          onClick={() => setCreating(true)}
        >
          新建标签
        </Button>
      )}
    >
      {isEmpty ? (
        <EmptyState
          title="暂无标签"
          description="标签用于辅助分类与筛选流水；点击下方按钮开始添加"
          action={
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setCreating(true)}
            >
              新建标签
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                <th className="py-2.5 pr-4 font-medium">颜色</th>
                <th className="py-2.5 pr-4 font-medium">名称</th>
                <th className="py-2.5 pr-4 font-medium w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {tags.map((t) => (
                <tr
                  key={t.id}
                  className="border-b border-border dark:border-border-dark last:border-b-0"
                >
                  <td className="py-3 pr-4">
                    <span
                      className="inline-block w-4 h-4 rounded-full"
                      style={{ backgroundColor: t.color ?? '#6b7280' }}
                    />
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <IconTag size={14} className="text-text-muted dark:text-text-muted-dark" />
                      <span className="font-medium">{t.name}</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(t)}
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
                        title="编辑"
                      >
                        <IconPencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleting(t)}
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-expense-soft hover:text-expense"
                        title="删除"
                      >
                        <IconTrash size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <TagFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={refetch}
      />
      <TagFormModal
        open={!!editing}
        tag={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={refetch}
      />
      <DeleteTagModal
        tag={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refetch}
      />
    </Card>
  );
}

function TagFormModal({
  open,
  tag,
  onClose,
  onSaved,
}: {
  open: boolean;
  tag?: Tag;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const isEdit = !!tag;
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(tag?.name ?? '');
    setColor(tag?.color ?? COLOR_OPTIONS[0]);
    setError(null);
  }, [open, tag]);

  async function save() {
    const nm = name.trim();
    if (!nm) {
      setError('请填写标签名');
      return;
    }
    setSaving(true);
    try {
      const payload = { name: nm, color };
      if (isEdit && tag?.id != null) {
        await apiFetch(`/api/tags/${tag.id}`, 'PUT', payload);
      } else {
        await apiFetch('/api/tags', 'POST', payload);
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError('保存失败：' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => (saving ? undefined : onClose())}
      title={isEdit ? '编辑标签' : '新建标签'}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">
            名称<span className="text-expense ml-0.5">*</span>
          </label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：必要"
            maxLength={20}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">颜色</label>
          <div className="flex flex-wrap gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={
                  color === c
                    ? 'w-6 h-6 rounded-full ring-2 ring-text dark:ring-bg-card ring-offset-2 ring-offset-bg-card dark:ring-offset-bg-card-dark'
                    : 'w-6 h-6 rounded-full'
                }
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
          </div>
        </div>
        {error && (
          <div className="text-xs text-expense bg-expense-soft dark:bg-expense-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DeleteTagModal({
  tag,
  onClose,
  onDeleted,
}: {
  tag: Tag | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (tag) setError(null);
  }, [tag]);

  async function handleConfirm() {
    if (!tag?.id) return;
    setBusy(true);
    try {
      await restDelete(`/api/tags/${tag.id}`);
      onDeleted?.();
      onClose();
    } catch (e) {
      setError('删除失败：' + (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!tag}
      onClose={() => (busy ? undefined : onClose())}
      title="删除标签"
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button variant="danger" onClick={handleConfirm} disabled={busy}>
            {busy ? '删除中…' : '确认删除'}
          </Button>
        </>
      }
    >
      <div className="text-sm space-y-2">
        <div>
          确定要删除标签「
          <span className="font-medium">{tag?.name || '—'}</span> 」吗？
        </div>
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
          该标签将从引用它的账户 / 流水中解除。
        </div>
        {error && (
          <div className="text-xs text-expense bg-expense-soft dark:bg-expense-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}