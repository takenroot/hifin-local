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
  Field,
  Input,
  Modal,
} from '@/components/ui';
import { apiFetch, useApi } from '@/hooks/useApi';
import type { AiModel } from '@/db';
import { ping, describeAiError } from '@/features/ai-assistant/client';
import {
  getDefaultModelId,
  setDefaultModelId,
} from '@/features/ai-assistant/storage';
import {
  restDelete,
  toAiModels,
  type RestAiModelRow,
} from '../restApi';

// Input 的 placeholder 色写死在 ui 组件里（无 dark 变体），这里用任意变体补暗黑态
const FIELD_INPUT_CLS =
  '[&_input]:placeholder:text-text-muted dark:[&_input]:placeholder:text-text-muted-dark';
// 共享 Field 的默认 label 是 text-sm + 主文字色；模型配置这组字段原本是更弱的 xs + muted
const AI_FIELD_LABEL = 'text-xs text-text-muted dark:text-text-muted-dark';

/**
 * hideApiKey=0：编辑模态需要回填 apiKey，默认列表会把 apiKey 脱敏成 null。
 * 这是本地应用，明文只走本地 REST，不出网。
 */
const AI_MODELS_API = '/api/ai-models?hideApiKey=0';

export function AiSection() {
  const { data, loading, refetch } = useApi<RestAiModelRow[]>(AI_MODELS_API);
  const models = useMemo(() => toAiModels(data ?? []), [data]);
  const [defaultId, setDefaultId] = useState<number | undefined>(undefined);

  // 默认模型 id 存 kv:ai.defaultModelId
  useEffect(() => {
    let mounted = true;
    void getDefaultModelId().then((v) => {
      if (mounted) setDefaultId(v);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const [editing, setEditing] = useState<AiModel | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<AiModel | null>(null);

  const isEmpty = !loading && models.length === 0;

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
            <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
              配置 AI 模型参数。本地版本默认关闭，仅在您主动添加模型后才会触发调用。
              地址需为 OpenAI 兼容端点（以 /v1 结尾，HiFin 会自行拼接 /chat/completions）——
              例如 MiniMax 用 https://api.minimax.cn/v1，不要填 /anthropic 协议地址。
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
            models={models}
            defaultId={defaultId}
            onEdit={(m) => setEditing(m)}
            onDelete={(m) => setDeleting(m)}
            onDefaultChange={setDefaultId}
          />
        )}
      </Card>

      <AiModelFormModal
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={() => setCreating(false)}
        onAfterCreate={refetch}
      />
      <AiModelFormModal
        open={!!editing}
        model={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={() => setEditing(null)}
        onAfterCreate={refetch}
      />
      <DeleteModelModal
        model={deleting}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting?.id) return;
          await restDelete(`/api/ai-models/${deleting.id}`);
          // 若删除的是默认模型，则清空默认 id
          if (defaultId != null && deleting.id === defaultId) {
            await setDefaultModelId(undefined);
            setDefaultId(undefined);
          }
          setDeleting(null);
          refetch();
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
  onDefaultChange,
}: {
  models: AiModel[];
  defaultId: number | undefined;
  onEdit: (m: AiModel) => void;
  onDelete: (m: AiModel) => void;
  onDefaultChange: (id: number | undefined) => void;
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
    onDefaultChange(model.id);
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
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
                    <IconRobot size={14} className="text-text-muted dark:text-text-muted-dark" />
                    <span className="font-medium">{m.name || '—'}</span>
                    {isDefault && (
                      <Badge tone="brand" className="ml-1 dark:bg-brand/15 dark:text-brand-dark">
                        <span className="inline-flex items-center gap-1">
                          <IconCheck size={10} /> 默认
                        </span>
                      </Badge>
                    )}
                  </div>
                </td>
                {/* 模型名单元格 truncate：模型 ID 可很长（MiniMax-M3.1-Flash-Preview），
                   不截断会把行撑成三行（用户 2026-10-07） */}
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark align-top max-w-[180px]">
                  <span className="block truncate" title={m.model ?? undefined}>
                    {m.model || '—'}
                  </span>
                </td>
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark truncate max-w-[320px] align-top">
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
                          ? 'bg-brand-soft dark:bg-brand/15 text-brand dark:text-brand-dark cursor-default'
                          : 'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
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
                        'border border-border dark:border-border-dark text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
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
                      className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
                      title="编辑"
                    >
                      <IconPencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(m)}
                      className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-expense-soft dark:hover:bg-expense-soft-dark hover:text-danger"
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
    return <span className="text-xs text-text-muted dark:text-text-muted-dark">未测试</span>;
  }
  if (state.status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-text-muted dark:text-text-muted-dark">
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
      className="inline-flex items-center gap-1 text-xs text-danger dark:text-danger-dark max-w-[200px]"
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
  /** 写操作后触发列表 refetch（新建时还要据此判断"首个模型"） */
  onAfterCreate?: () => void;
}

function AiModelFormModal({
  open,
  model,
  onClose,
  onSaved,
  onAfterCreate,
}: AiModelFormModalProps) {
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
        await apiFetch(`/api/ai-models/${model.id}`, 'PUT', payload);
      } else {
        // core 的 POST 会回传带 id 的新模型行
        const created = await apiFetch<RestAiModelRow>('/api/ai-models', 'POST', payload);
        // 新建后自动设为默认（首个有效模型）
        if (created?.id != null) {
          const list = await fetch(AI_MODELS_API);
          const all = list.ok ? ((await list.json()) as RestAiModelRow[]) : [];
          if (all.length === 1) {
            await setDefaultModelId(created.id);
          }
        }
      }
      onAfterCreate?.();
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
        <Field label="名称" required htmlFor="ai-name" labelClassName={AI_FIELD_LABEL}>
          <Input
            id="ai-name"
            className={FIELD_INPUT_CLS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：智谱 GLM"
            maxLength={20}
          />
        </Field>
        <Field label="模型" required htmlFor="ai-model" labelClassName={AI_FIELD_LABEL}>
          <Input
            id="ai-model"
            className={FIELD_INPUT_CLS}
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="例如：glm-4-plus"
            maxLength={40}
          />
        </Field>
        <Field label="地址" required htmlFor="ai-endpoint" labelClassName={AI_FIELD_LABEL}>
          <Input
            id="ai-endpoint"
            className={FIELD_INPUT_CLS}
            value={endpoint}
            onChange={(e) => setEndpoint(e.target.value)}
            placeholder="https://open.bigmodel.cn/api/paas/v4/chat/completions"
          />
        </Field>
        <Field label="API Key（可选）" htmlFor="ai-key" labelClassName={AI_FIELD_LABEL}>
          <Input
            id="ai-key"
            className={FIELD_INPUT_CLS}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="本地保存，不上传"
            type="password"
          />
        </Field>
        {error && (
          <div className="text-xs text-danger dark:text-danger-dark bg-danger-soft dark:bg-danger-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
          所有字段仅保存在本地服务（core / SQLite），不会上传到任何远端。提示：
          <Badge tone="brand" className="ml-1 align-middle dark:bg-brand/15 dark:text-brand-dark">本地</Badge>
        </div>
      </div>
    </Modal>
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
      <div className="text-sm text-text dark:text-text-dark">
        确定要删除模型「
        <span className={clsx('font-medium')}>{model?.name || '—'}</span> 」吗？此操作不可撤销。
      </div>
    </Modal>
  );
}