/**
 * 设置 → AI 配置（aiModels 表 CRUD）
 *
 * - 列表 + 空态（"本地版本默认关闭"）
 * - 每个模型可「设为默认」+「测试连接」
 * - 新建 / 编辑模态：名称 / 模型 / 地址
 * - 删除二次确认
 *
 * 默认模型 id 写入 kv:ai.defaultModelId；
 * 测试连接：发一条最小 ping 到 endpoint，显示延迟或错误归因。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconRobot,
  IconCheck,
  IconBolt,
  IconClock,
  IconAlertTriangle,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
} from '@/components/ui';
import { db, type AiModel } from '@/db';
import { ping, describeAiError } from '@/features/ai-assistant/client';
import { setDefaultModelId } from '@/features/ai-assistant/storage';

export function AiSection() {
  const models = useLiveQuery(
    () => db.aiModels.orderBy('name').toArray(),
    [],
  );
  const defaultKv = useLiveQuery(() => db.kv.get('ai.defaultModelId'), []);
  const defaultId =
    typeof (defaultKv?.value as unknown) === 'number'
      ? (defaultKv?.value as number)
      : undefined;

  const [editing, setEditing] = useState<AiModel | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AiModel | null>(null);

  const isEmpty = (models?.length ?? 0) === 0;

  const headerActions = (
    <Button
      variant="primary"
      icon={<IconPlus size={16} />}
      onClick={() => setCreating(true)}
    >
      新建模型
    </Button>
  );

  return (
    <div className="space-y-4">
      <Card
        title={
          <div>
            <div className="text-base font-medium">AI 模型</div>
            <div className="text-xs text-text-muted mt-1">
              配置 AI 模型参数。本地版本默认关闭，仅在您主动添加模型后才会触发调用。
            </div>
          </div>
        }
        extra={!isEmpty && headerActions}
      >
        {isEmpty ? (
          <EmptyState
            title="本地版本默认关闭"
            description="尚未配置任何 AI 模型。如需启用，请点击下方按钮新建模型。模型名称、模型 ID 与 API 地址将保存到本地数据库。"
            action={
              <Button
                variant="primary"
                icon={<IconPlus size={16} />}
                onClick={() => setCreating(true)}
              >
                新建模型
              </Button>
            }
          />
        ) : (
          <ModelsTable
            models={models ?? []}
            defaultId={defaultId}
            onEdit={(m) => setEditing(m)}
            onDelete={(m) => setDeleting(m)}
          />
        )}
      </Card>

      <AiModelFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => setCreating(false)}
      />
      <AiModelFormModal
        open={!!editing}
        model={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
      />
      <DeleteModelModal
        model={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting?.id) return;
          await db.aiModels.delete(deleting.id);
          // 若删除的是默认模型，则清空默认 id
          if (defaultId != null && deleting.id === defaultId) {
            await setDefaultModelId(undefined);
          }
          setDeleting(null);
        }}
      />
    </div>
  );
}

interface TestState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  latencyMs?: number;
  message?: string;
}

function ModelsTable({
  models,
  defaultId,
  onEdit,
  onDelete,
}: {
  models: AiModel[];
  defaultId: number | undefined;
  onEdit: (m: AiModel) => void;
  onDelete: (m: AiModel) => void;
}) {
  // 每个模型的测试状态；key 为模型 id
  const [testState, setTestState] = useState<Record<number, TestState>>({});
  // 用 ref 取消正在进行的测试
  const abortRef = useRef<Record<number, AbortController>>({});

  useEffect(() => {
    return () => {
      // 卸载时取消全部
      Object.values(abortRef.current).forEach((c) => c.abort());
    };
  }, []);

  async function runTest(model: AiModel) {
    if (model.id == null) return;
    abortRef.current[model.id]?.abort();
    const ctrl = new AbortController();
    abortRef.current[model.id] = ctrl;

    setTestState((s) => ({ ...s, [model.id!]: { status: 'loading' } }));
    try {
      const res = await ping(model, { signal: ctrl.signal });
      setTestState((s) => ({
        ...s,
        [model.id!]: {
          status: 'ok',
          latencyMs: res.latencyMs,
        },
      }));
    } catch (e) {
      setTestState((s) => ({
        ...s,
        [model.id!]: {
          status: 'error',
          message: describeAiError(e),
        },
      }));
    } finally {
      delete abortRef.current[model.id!];
    }
  }

  async function setDefault(model: AiModel) {
    if (model.id == null) return;
    await setDefaultModelId(model.id);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted border-b border-border dark:border-border-dark">
            <th className="py-2.5 pr-4 font-medium">名称</th>
            <th className="py-2.5 pr-4 font-medium">模型</th>
            <th className="py-2.5 pr-4 font-medium">地址</th>
            <th className="py-2.5 pr-4 font-medium">测试</th>
            <th className="py-2.5 pr-4 font-medium w-72">操作</th>
          </tr>
        </thead>
        <tbody>
          {models.map((m) => {
            const isDefault = m.id != null && m.id === defaultId;
            const state = m.id != null ? testState[m.id] : undefined;
            return (
              <tr
                key={m.id}
                className="border-b border-border dark:border-border-dark last:border-b-0"
              >
                <td className="py-3 pr-4 align-top">
                  <div className="flex items-center gap-2">
                    <IconRobot size={14} className="text-text-muted" />
                    <span className="font-medium">{m.name || '—'}</span>
                    {isDefault && (
                      <Badge tone="brand" className="ml-1">
                        <span className="inline-flex items-center gap-1">
                          <IconCheck size={10} /> 默认
                        </span>
                      </Badge>
                    )}
                  </div>
                </td>
                <td className="py-3 pr-4 text-text-muted align-top">
                  {m.model || '—'}
                </td>
                <td className="py-3 pr-4 text-text-muted truncate max-w-[320px] align-top">
                  {m.endpoint || '—'}
                </td>
                <td className="py-3 pr-4 align-top">
                  <TestBadge state={state} />
                </td>
                <td className="py-3 pr-4 align-top">
                  <div className="flex flex-wrap items-center gap-1">
                    <button
                      type="button"
                      onClick={() => void setDefault(m)}
                      disabled={isDefault}
                      className={clsx(
                        'inline-flex items-center gap-1 px-2 h-8 rounded-lg text-xs',
                        isDefault
                          ? 'bg-brand-soft text-brand cursor-default'
                          : 'border border-border dark:border-border-dark text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
                      )}
                      title={isDefault ? '当前默认模型' : '设为默认'}
                    >
                      <IconCheck size={12} />
                      {isDefault ? '已默认' : '设为默认'}
                    </button>
                    <button
                      type="button"
                      onClick={() => void runTest(m)}
                      disabled={state?.status === 'loading'}
                      className={clsx(
                        'inline-flex items-center gap-1 px-2 h-8 rounded-lg text-xs',
                        'border border-border dark:border-border-dark text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
                        'disabled:opacity-50 disabled:cursor-not-allowed',
                      )}
                      title="测试连接"
                    >
                      <IconBolt size={12} />
                      测试连接
                    </button>
                    <button
                      type="button"
                      onClick={() => onEdit(m)}
                      className="p-1.5 rounded-lg text-text-muted hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
                      title="编辑"
                    >
                      <IconPencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(m)}
                      className="p-1.5 rounded-lg text-text-muted hover:bg-expense-soft hover:text-expense"
                      title="删除"
                    >
                      <IconTrash size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function TestBadge({ state }: { state?: TestState }) {
  if (!state || state.status === 'idle') {
    return <span className="text-xs text-text-muted">未测试</span>;
  }
  if (state.status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted">
        <IconBolt size={12} className="animate-pulse" />
        测试中…
      </span>
    );
  }
  if (state.status === 'ok') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-income">
        <IconClock size={12} />
        {state.latencyMs} ms
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-expense max-w-[200px]"
      title={state.message}
    >
      <IconAlertTriangle size={12} />
      <span className="truncate">{state.message || '失败'}</span>
    </span>
  );
}

// ─────────────── 表单模态 ───────────────

interface AiModelFormModalProps {
  open: boolean;
  model?: AiModel;
  onClose: () => void;
  onSaved: () => void;
}

function AiModelFormModal({ open, model, onClose, onSaved }: AiModelFormModalProps) {
  const isEdit = !!model;
  const [name, setName] = useState('');
  const [modelName, setModelName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 进入编辑模式时回填
  useEffect(() => {
    if (!open) return;
    setName(model?.name ?? '');
    setModelName(model?.model ?? '');
    setEndpoint(model?.endpoint ?? '');
    setApiKey(model?.apiKey ?? '');
    setError(null);
  }, [open, model]);

  const valid = useMemo(
    () => name.trim() && modelName.trim() && endpoint.trim(),
    [name, modelName, endpoint],
  );

  async function save() {
    if (!valid) {
      setError('请填写名称、模型与地址');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: name.trim(),
        model: modelName.trim(),
        endpoint: endpoint.trim(),
        apiKey: apiKey.trim() || undefined,
      };
      if (isEdit && model?.id != null) {
        await db.aiModels.update(model.id, payload);
      } else {
        await db.aiModels.add({
          ...payload,
        } as AiModel);
        // 新建后自动设为默认（首个有效模型）
        const total = await db.aiModels.count();
        if (total === 1) {
          const inserted = await db.aiModels.toArray();
          const fresh = inserted[inserted.length - 1];
          if (fresh?.id != null) {
            await setDefaultModelId(fresh.id);
          }
        }
      }
      onSaved();
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
      title={isEdit ? '编辑模型' : '新建模型'}
      width={520}
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
        <Field label="名称" required>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：智谱 GLM"
            maxLength={20}
          />
        </Field>
        <Field label="模型" required>
          <Input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="例如：glm-4-plus"
            maxLength={40}
          />
        </Field>
        <Field label="地址" required>
          <Input
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://open.bigmodel.cn/api/paas/v4/chat/completions"
          />
        </Field>
        <Field label="API Key（可选）">
          <Input
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="本地保存，不上传"
            type="password"
          />
        </Field>
        {error && (
          <div className="text-xs text-expense bg-expense-soft dark:bg-expense-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        <div className="text-xs text-text-muted">
          所有字段仅保存在本地浏览器（IndexedDB）。提示：
          <Badge tone="brand" className="ml-1 align-middle">本地</Badge>
        </div>
      </div>
    </Modal>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-xs text-text-muted mb-1.5">
        {label}
        {required && <span className="text-expense ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// ─────────────── 删除确认 ───────────────

function DeleteModelModal({
  model,
  onClose,
  onConfirm,
}: {
  model: AiModel | null;
  onClose: () => void;
  onConfirm: () => Promise<void> | void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleConfirm() {
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!model}
      onClose={() => (busy ? undefined : onClose())}
      title="删除模型"
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
      <div className="text-sm">
        确定要删除模型「
        <span className={clsx('font-medium')}>{model?.name || '—'}</span> 」吗？此操作不可撤销。
      </div>
    </Modal>
  );
}