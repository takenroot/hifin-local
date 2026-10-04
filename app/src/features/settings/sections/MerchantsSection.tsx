/**
 * 设置 → 商户管理
 *
 * merchants 表 CRUD：名称 + 备注
 */
import { useEffect, useMemo, useState } from 'react';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconBuildingStore,
} from '@tabler/icons-react';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Textarea,
} from '@/components/ui';
import { apiFetch, useApi } from '@/hooks/useApi';
import type { Merchant } from '@/db';
import { restDelete, toMerchants, type RestMerchantRow } from '../restApi';

// Input 的 placeholder 色写死在 ui 组件里（无 dark 变体），这里用任意变体补暗黑态
const FIELD_INPUT_CLS =
  '[&_input]:placeholder:text-text-muted dark:[&_input]:placeholder:text-text-muted-dark';
const FIELD_TEXTAREA_CLS =
  'placeholder:text-text-muted dark:placeholder:text-text-muted-dark';

export function MerchantsSection() {
  const { data, loading, refetch } = useApi<RestMerchantRow[]>('/api/merchants');
  const merchants = useMemo(
    () =>
      toMerchants(data ?? []).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    [data],
  );
  const [editing, setEditing] = useState<Merchant | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Merchant | null>(null);

  const isEmpty = !loading && merchants.length === 0;

  return (
    <Card
      title={
        <div>
          <div className="text-base font-medium">商户管理</div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
            自定义商户，便于按商户筛选流水
          </div>
        </div>
      }
      extra={!isEmpty && (
        <Button
          variant="primary"
          icon={<IconPlus size={16} />}
          onClick={() => setCreating(true)}
        >
          新建商户
        </Button>
      )}
    >
      {isEmpty ? (
        <EmptyState
          title="暂无商户"
          description="商户用于将同类商家（如超市、餐厅）聚合统计。"
          action={
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setCreating(true)}
            >
              新建商户
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                <th className="py-2.5 pr-4 font-medium">名称</th>
                <th className="py-2.5 pr-4 font-medium">备注</th>
                <th className="py-2.5 pr-4 font-medium w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {merchants.map((m) => (
                <tr
                  key={m.id}
                  className="border-b border-border dark:border-border-dark last:border-b-0"
                >
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-2">
                      <IconBuildingStore size={14} className="text-text-muted dark:text-text-muted-dark" />
                      <span className="font-medium">{m.name}</span>
                    </div>
                  </td>
                  <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark">
                    {m.remark || '—'}
                  </td>
                  <td className="py-3 pr-4">
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => setEditing(m)}
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
                        title="编辑"
                      >
                        <IconPencil size={14} />
                      </button>
                      <button
                        type="button"
                        onClick={() => setDeleting(m)}
                        className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-expense-soft dark:hover:bg-expense-soft-dark hover:text-danger"
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

      <MerchantFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={refetch}
      />
      <MerchantFormModal
        open={!!editing}
        merchant={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={refetch}
      />
      <DeleteMerchantModal
        merchant={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refetch}
      />
    </Card>
  );
}

function MerchantFormModal({
  open,
  merchant,
  onClose,
  onSaved,
}: {
  open: boolean;
  merchant?: Merchant;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const isEdit = !!merchant;
  const [name, setName] = useState('');
  const [remark, setRemark] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(merchant?.name ?? '');
    setRemark(merchant?.remark ?? '');
    setError(null);
  }, [open, merchant]);

  async function save() {
    const nm = name.trim();
    if (!nm) {
      setError('请填写商户名');
      return;
    }
    setSaving(true);
    try {
      const payload = { name: nm, remark: remark.trim() || undefined };
      if (isEdit && merchant?.id != null) {
        await apiFetch(`/api/merchants/${merchant.id}`, 'PUT', payload);
      } else {
        await apiFetch('/api/merchants', 'POST', payload);
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
      title={isEdit ? '编辑商户' : '新建商户'}
      width={460}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={saving}
            className="disabled:opacity-50 disabled:cursor-not-allowed"
          >
            取消
          </Button>
          <Button variant="primary" onClick={save} disabled={saving}>
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      {/* 根节点自带前景色：Modal 走 portal，脱离 AppLayout 的 text-text 根节点 */}
      <div className="space-y-3 text-text dark:text-text-dark">
        <div>
          <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">
            名称<span className="text-danger dark:text-danger-dark ml-0.5">*</span>
          </label>
          <Input
            className={FIELD_INPUT_CLS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：星巴克"
            maxLength={20}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">备注</label>
          <Textarea
            className={FIELD_TEXTAREA_CLS}
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="可选；最多 200 字"
            maxLength={200}
          />
          <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark text-right">
            {remark.length}/200
          </div>
        </div>
        {error && (
          <div className="text-xs text-danger dark:text-danger-dark bg-danger-soft dark:bg-danger-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

function DeleteMerchantModal({
  merchant,
  onClose,
  onDeleted,
}: {
  merchant: Merchant | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (merchant) setError(null);
  }, [merchant]);

  async function handleConfirm() {
    if (!merchant?.id) return;
    setBusy(true);
    try {
      await restDelete(`/api/merchants/${merchant.id}`);
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
      open={!!merchant}
      onClose={() => (busy ? undefined : onClose())}
      title="删除商户"
      width={420}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={onClose}
            disabled={busy}
            className="disabled:opacity-50 disabled:cursor-not-allowed"
          >
            取消
          </Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={busy}
            className="disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {busy ? '删除中…' : '确认删除'}
          </Button>
        </>
      }
    >
      <div className="text-sm space-y-2 text-text dark:text-text-dark">
        <div>
          确定要删除商户「
          <span className="font-medium">{merchant?.name || '—'}</span> 」吗？
        </div>
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
          该商户从引用它的流水中解除；流水仍保留。
        </div>
        {error && (
          <div className="text-xs text-danger dark:text-danger-dark bg-danger-soft dark:bg-danger-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}