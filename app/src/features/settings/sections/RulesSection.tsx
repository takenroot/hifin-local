/**
 * 设置 → 交易规则
 * ---------------------------------------------------------------
 * 自动归类规则 CRUD：
 *   - 关键词（不区分大小写包含匹配）
 *   - 匹配字段：流水名称 / 商户 / 备注
 *   - 目标分类（下拉读 categories 表）
 *   - 优先级（数字越大越优先）
 *   - 启用开关
 *
 * 表格按 priority 降序展示；空态引导用户创建第一条规则。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconBolt,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Switch,
} from '@/components/ui';
import { apiFetch, useApi } from '@/hooks/useApi';
import type { Category, RuleMatchField, TxRule } from '@/db';
import {
  restDelete,
  toCategories,
  toRules,
  type RestCategoryRow,
  type RestRuleRow,
} from '../restApi';

const MATCH_FIELD_OPTIONS: Array<{ label: string; value: RuleMatchField }> = [
  { label: '流水名称', value: 'name' },
  { label: '商户', value: 'merchant' },
  { label: '备注', value: 'remark' },
];

const MATCH_FIELD_LABEL: Record<RuleMatchField, string> = {
  name: '流水名称',
  merchant: '商户',
  remark: '备注',
};

export function RulesSection() {
  // core 的 GET /api/rules 已按 priority DESC, id ASC 排序
  const { data: ruleRows, loading, refetch } = useApi<RestRuleRow[]>('/api/rules');
  const { data: categoryRows } = useApi<RestCategoryRow[]>('/api/categories');
  const rules = useMemo(() => toRules(ruleRows ?? []), [ruleRows]);
  const categories = useMemo(() => toCategories(categoryRows ?? []), [categoryRows]);

  const [editing, setEditing] = useState<TxRule | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TxRule | null>(null);

  const categoryMap = useMemo(() => {
    const m = new Map<number, Category>();
    for (const c of categories) {
      if (c.id != null) m.set(c.id, c);
    }
    return m;
  }, [categories]);

  const isEmpty = !loading && rules.length === 0;

  return (
    <Card
      title={
        <div>
          <div className="text-base font-medium">交易规则</div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
            按关键词自动归类流水，导入或新建时自动套用
          </div>
        </div>
      }
      extra={
        !isEmpty && (
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            onClick={() => setCreating(true)}
          >
            新建规则
          </Button>
        )
      }
    >
      {isEmpty ? (
        <EmptyState
          title="还没有交易规则"
          description="新建一条规则：当流水名称 / 商户 / 备注包含指定关键词时，自动归入目标分类。"
          action={
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setCreating(true)}
            >
              新建第一条规则
            </Button>
          }
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                <th className="py-2.5 pr-4 font-medium">关键词</th>
                <th className="py-2.5 pr-4 font-medium">匹配字段</th>
                <th className="py-2.5 pr-4 font-medium">目标分类</th>
                <th className="py-2.5 pr-4 font-medium">优先级</th>
                <th className="py-2.5 pr-4 font-medium">启用</th>
                <th className="py-2.5 pr-4 font-medium w-24">操作</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => {
                const cat = r.categoryId != null ? categoryMap.get(r.categoryId) : undefined;
                return (
                  <tr
                    key={r.id}
                    className={clsx(
                      'border-b border-border dark:border-border-dark last:border-b-0',
                      !r.enabled && 'opacity-50',
                    )}
                  >
                    <td className="py-3 pr-4 font-medium">
                      <div className="flex items-center gap-1.5">
                        <IconBolt size={12} className="text-brand flex-none" />
                        <span className="truncate max-w-[200px]">{r.keyword}</span>
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark">
                      {MATCH_FIELD_LABEL[r.matchField]}
                    </td>
                    <td className="py-3 pr-4">
                      {cat ? (
                        <span className="inline-flex items-center gap-1.5">
                          {cat.icon && <span>{cat.icon}</span>}
                          <span>{cat.name}</span>
                          <span className="text-xs text-text-muted dark:text-text-muted-dark">
                            ({cat.group})
                          </span>
                        </span>
                      ) : (
                        <span className="text-text-muted dark:text-text-muted-dark text-xs">
                          分类已删除
                        </span>
                      )}
                    </td>
                    <td className="py-3 pr-4 tabular-nums text-text-muted dark:text-text-muted-dark">
                      {r.priority}
                    </td>
                    <td className="py-3 pr-4">
                      <Switch
                        size="sm"
                        checked={r.enabled}
                        onChange={(v) => toggleEnabled(r, v, refetch)}
                      />
                    </td>
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setEditing(r)}
                          className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark"
                          title="编辑"
                        >
                          <IconPencil size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setDeleting(r)}
                          className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:bg-expense-soft hover:text-expense"
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
      )}

      <RuleFormModal
        open={creating}
        categories={categories}
        onClose={() => setCreating(false)}
        onSaved={refetch}
      />
      <RuleFormModal
        open={!!editing}
        rule={editing ?? undefined}
        categories={categories}
        onClose={() => setEditing(null)}
        onSaved={refetch}
      />
      <DeleteRuleModal
        rule={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={refetch}
      />
    </Card>
  );
}

async function toggleEnabled(rule: TxRule, v: boolean, refetch: () => void) {
  if (rule.id == null) return;
  await apiFetch(`/api/rules/${rule.id}`, 'PUT', { enabled: v });
  refetch();
}

/* ─────────── 表单模态 ─────────── */

interface RuleFormModalProps {
  open: boolean;
  rule?: TxRule;
  categories: Category[];
  onClose: () => void;
  onSaved?: () => void;
}

function RuleFormModal({
  open,
  rule,
  categories,
  onClose,
  onSaved,
}: RuleFormModalProps) {
  const isEdit = !!rule;
  const [keyword, setKeyword] = useState('');
  const [matchField, setMatchField] = useState<RuleMatchField>('name');
  const [categoryId, setCategoryId] = useState<string>('');
  const [priority, setPriority] = useState<string>('0');
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKeyword(rule?.keyword ?? '');
    setMatchField((rule?.matchField as RuleMatchField) ?? 'name');
    setCategoryId(rule?.categoryId != null ? String(rule.categoryId) : '');
    setPriority(String(rule?.priority ?? 0));
    setEnabled(rule?.enabled ?? true);
    setError(null);
  }, [open, rule]);

  // 分类下拉，按类型分组
  const categoryOptions = useMemo(() => {
    const groups = new Map<string, Category[]>();
    for (const c of categories) {
      const arr = groups.get(c.group) ?? [];
      arr.push(c);
      groups.set(c.group, arr);
    }
    const opts: Array<{ label: string; value: string; disabled?: boolean }> = [];
    for (const [group, cats] of groups.entries()) {
      opts.push({ label: `— ${group} —`, value: `_${group}`, disabled: true });
      for (const c of cats) {
        opts.push({
          label: `${c.icon ? `${c.icon} ` : ''}${c.name}`,
          value: String(c.id),
        });
      }
    }
    return opts;
  }, [categories]);

  async function save() {
    const kw = keyword.trim();
    if (!kw) {
      setError('请填写关键词');
      return;
    }
    if (!categoryId || Number.isNaN(Number(categoryId))) {
      setError('请选择目标分类');
      return;
    }
    const pri = Number(priority);
    if (!Number.isFinite(pri)) {
      setError('优先级必须为数字');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        keyword: kw,
        matchField,
        categoryId: Number(categoryId),
        priority: pri,
        enabled,
      };
      if (isEdit && rule?.id != null) {
        await apiFetch(`/api/rules/${rule.id}`, 'PUT', payload);
      } else {
        // core 的 POST 由服务端写 createdAt
        await apiFetch('/api/rules', 'POST', payload);
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
      title={isEdit ? '编辑规则' : '新建规则'}
      width={460}
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
        <Row label="关键词" required>
          <Input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            placeholder="例如：星巴克 / 滴滴 / 工资"
            maxLength={40}
          />
        </Row>
        <Row label="匹配字段" required>
          <Select
            value={matchField}
            options={MATCH_FIELD_OPTIONS}
            onChange={(e) => setMatchField(e.target.value as RuleMatchField)}
          />
        </Row>
        <Row label="目标分类" required>
          <Select
            placeholder="请选择分类"
            value={categoryId}
            options={categoryOptions}
            onChange={(e) => setCategoryId(e.target.value)}
          />
        </Row>
        <Row label="优先级" required>
          <Input
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            placeholder="数字越大越优先"
          />
        </Row>
        <Row label="启用">
          <div className="flex items-center gap-2 h-10">
            <Switch checked={enabled} onChange={setEnabled} size="sm" />
            <span className="text-sm text-text-muted dark:text-text-muted-dark">
              {enabled ? '启用' : '停用'}
            </span>
          </div>
        </Row>
        {error && (
          <div className="text-xs text-expense bg-expense-soft dark:bg-expense-soft-dark px-3 py-2 rounded-lg">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ─────────── 删除确认 ─────────── */

function DeleteRuleModal({
  rule,
  onClose,
  onDeleted,
}: {
  rule: TxRule | null;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (rule) setError(null);
  }, [rule]);

  async function handleConfirm() {
    if (!rule?.id) return;
    setBusy(true);
    try {
      await restDelete(`/api/rules/${rule.id}`);
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
      open={!!rule}
      onClose={() => (busy ? undefined : onClose())}
      title="删除规则"
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
          确定要删除规则「
          <span className="font-medium">{rule?.keyword || '—'}</span> 」吗？
        </div>
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
          删除后，已应用该规则的流水不会自动还原。
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

function Row({
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
      <label className="block text-xs text-text-muted dark:text-text-muted-dark mb-1.5">
        {label}
        {required && <span className="text-expense ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}