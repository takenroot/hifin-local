/**
 * 设置 → 分组分类
 *
 * - 顶部"配置列表"卡片（展示默认配置，含实际 seed 数量统计）
 * - 下方：左侧分组树 + 右侧分类列表
 * - 数据源：GET /api/categories（REST 返回平铺列表，分组在前端按 group 聚合）
 * - 写操作：core 仅提供 POST /api/categories，**没有** PUT / DELETE，
 *   因此编辑与删除入口在服务端补齐前先禁用（不保留 Dexie 旁路）。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  IconPlus,
  IconPencil,
  IconTrash,
  IconCheck,
  IconChevronRight,
  IconCategory,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  Input,
  Modal,
  Select,
  Spinner,
} from '@/components/ui';
import { apiFetch, useApi } from '@/hooks/useApi';
import type { Category, CategoryType } from '@/db';
import { toCategories, type RestCategoryRow } from '../restApi';
import { formatDate } from '../format';

const TYPE_LABEL: Record<CategoryType, string> = {
  expense: '支出',
  income: '收入',
};

const TYPE_TONE: Record<CategoryType, 'expense' | 'income'> = {
  expense: 'expense',
  income: 'income',
};

// Input 的 placeholder 色写死在 ui 组件里（无 dark 变体），这里用任意变体补暗黑态
const FIELD_INPUT_CLS =
  '[&_input]:placeholder:text-text-muted dark:[&_input]:placeholder:text-text-muted-dark';

/** core 未提供分类的更新 / 删除端点，功能入口随之禁用。 */
const CATEGORIES_MUTABLE = false;

export function CategoriesSection() {
  const { data, loading, refetch } = useApi<RestCategoryRow[]>('/api/categories');
  const categories = useMemo(() => toCategories(data ?? []), [data]);

  // 实际分组与统计（REST 平铺列表 → 前端按 group 聚合）
  const groups = useMemo(() => {
    const map = new Map<string, Category[]>();
    for (const c of categories) {
      const arr = map.get(c.group) ?? [];
      arr.push(c);
      map.set(c.group, arr);
    }
    return Array.from(map.entries())
      .map(([name, items]) => ({
        name,
        items,
        expenseCount: items.filter((i) => i.type === 'expense').length,
        incomeCount: items.filter((i) => i.type === 'income').length,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [categories]);

  const totalCategories = categories.length;
  const totalGroups = groups.length;

  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  // 首次加载自动选中第一个分组
  useEffect(() => {
    if (!activeGroup && groups.length > 0) {
      setActiveGroup(groups[0].name);
    }
  }, [activeGroup, groups]);

  const [editing, setEditing] = useState<Category | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Category | null>(null);

  const currentGroup = groups.find((g) => g.name === activeGroup) ?? null;

  return (
    <div className="space-y-4">
      {/* 配置列表卡片 */}
      <Card
        title="配置列表（共1个）"
        extra={
          <Button variant="primary" icon={<IconPlus size={16} />} disabled>
            新建配置
          </Button>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                <th className="py-2.5 pr-4 font-medium">配置名称</th>
                <th className="py-2.5 pr-4 font-medium">当前启用</th>
                <th className="py-2.5 pr-4 font-medium">分类数量</th>
                <th className="py-2.5 pr-4 font-medium">分组数量</th>
                <th className="py-2.5 pr-4 font-medium">创建时间</th>
                <th className="py-2.5 pr-4 font-medium">更新时间</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-b border-border dark:border-border-dark last:border-b-0">
                <td className="py-3 pr-4">
                  <span className="text-brand font-medium">默认配置</span>
                </td>
                <td className="py-3 pr-4">
                  <IconCheck size={16} className="text-income" />
                </td>
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark tabular-nums">
                  {totalCategories}/{totalCategories}
                </td>
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark tabular-nums">
                  {totalGroups}
                </td>
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark">
                  {formatDate(Date.now())}
                </td>
                <td className="py-3 pr-4 text-text-muted dark:text-text-muted-dark">
                  {formatDate(Date.now())}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </Card>

      {/* 分组 + 分类 */}
      <div className="grid grid-cols-1 md:grid-cols-[240px,1fr] gap-4">
        <Card
          title={
            <div className="flex items-center gap-2 text-sm font-medium text-text dark:text-text-dark">
              <IconCategory size={14} className="flex-none text-text-muted dark:text-text-muted-dark" />
              <span>分组</span>
            </div>
          }
          flush
        >
          <div className="p-3">
            {loading ? (
              <div className="text-xs text-text-muted dark:text-text-muted-dark px-2 py-3">加载中…</div>
            ) : groups.length === 0 ? (
              <div className="text-xs text-text-muted dark:text-text-muted-dark px-2 py-3">暂无分组</div>
            ) : (
              <ul className="space-y-0.5">
                {groups.map((g) => (
                  <li key={g.name}>
                    <button
                      type="button"
                      onClick={() => setActiveGroup(g.name)}
                      className={clsx(
                        'w-full flex items-center justify-between gap-2 h-9 px-3 rounded-lg text-sm transition',
                        g.name === activeGroup
                          ? 'bg-bg dark:bg-bg-card-dark text-text dark:text-text-dark font-medium'
                          : 'text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
                      )}
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <IconCategory size={14} className="flex-none" />
                        <span className="truncate">{g.name}</span>
                      </span>
                      <span className="flex items-center gap-1.5 flex-none">
                        <span className="text-xs tabular-nums text-text-muted dark:text-text-muted-dark">
                          {g.items.length}
                        </span>
                        <IconChevronRight
                          size={12}
                          className={clsx(
                            'transition',
                            g.name === activeGroup
                              ? 'text-text dark:text-text-dark'
                              : 'text-text-muted dark:text-text-muted-dark',
                          )}
                        />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card
          title={
            <div>
              <div className="text-base font-medium">
                {currentGroup?.name ?? '分类'}
              </div>
              {currentGroup && (
                <div className="text-xs text-text-muted dark:text-text-muted-dark mt-1">
                  {currentGroup.expenseCount} 个支出 · {currentGroup.incomeCount} 个收入
                </div>
              )}
            </div>
          }
          extra={
            currentGroup && (
              <Button
                variant="primary"
                size="sm"
                icon={<IconPlus size={14} />}
                onClick={() => setCreating(true)}
              >
                新建分类
              </Button>
            )
          }
        >
          {loading ? (
            // 数据在路上先占位：否则右栏会先闪一帧"选择左侧分组"
            <div className="py-10 flex justify-center">
              <Spinner />
            </div>
          ) : !currentGroup ? (
            <EmptyState
              title="选择左侧分组"
              description="点击左侧分组名称以查看该分组下的分类。"
            />
          ) : currentGroup.items.length === 0 ? (
            <EmptyState
              title="该分组还没有分类"
              description="点击「新建分类」开始添加"
              action={
                <Button
                  variant="primary"
                  icon={<IconPlus size={16} />}
                  onClick={() => setCreating(true)}
                >
                  新建分类
                </Button>
              }
            />
          ) : (
            <CategoryTable
              items={currentGroup.items}
              onEdit={(c) => setEditing(c)}
              onDelete={(c) => setDeleting(c)}
              mutable={CATEGORIES_MUTABLE}
            />
          )}
        </Card>
      </div>

      <CategoryFormModal
        open={creating}
        group={currentGroup?.name ?? ''}
        onClose={() => setCreating(false)}
        onSaved={refetch}
      />
      <CategoryFormModal
        open={!!editing}
        category={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={refetch}
      />
      <DeleteCategoryModal
        category={deleting}
        onClose={() => setDeleting(null)}
      />
    </div>
  );
}

function CategoryTable({
  items,
  onEdit,
  onDelete,
  mutable,
}: {
  items: Category[];
  onEdit: (c: Category) => void;
  onDelete: (c: Category) => void;
  /** core 无 PUT/DELETE 端点时为 false，编辑/删除入口禁用 */
  mutable: boolean;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
            <th className="py-2.5 pr-4 font-medium">图标</th>
            <th className="py-2.5 pr-4 font-medium">名称</th>
            <th className="py-2.5 pr-4 font-medium">类型</th>
            <th className="py-2.5 pr-4 font-medium w-24">操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c) => (
            <tr
              key={c.id}
              className="border-b border-border dark:border-border-dark last:border-b-0"
            >
              <td className="py-3 pr-4 text-xl">
                {c.icon || <IconCategory size={18} />}
              </td>
              <td className="py-3 pr-4 font-medium">
                <div className="flex items-center gap-2">
                  <span>{c.name}</span>
                  {c.color && (
                    <span
                      className="inline-block w-3 h-3 rounded-full"
                      style={{ backgroundColor: c.color }}
                    />
                  )}
                </div>
              </td>
              <td className="py-3 pr-4">
                <Badge tone={TYPE_TONE[c.type]}>{TYPE_LABEL[c.type]}</Badge>
              </td>
              <td className="py-3 pr-4">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onEdit(c)}
                    disabled={!mutable}
                    className={clsx(
                      'p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark',
                      mutable &&
                        'hover:bg-bg dark:hover:bg-bg-card-dark hover:text-text dark:hover:text-text-dark',
                      !mutable && 'opacity-40 cursor-not-allowed',
                    )}
                    title={mutable ? '编辑' : '服务端暂未提供分类更新接口'}
                  >
                    <IconPencil size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onDelete(c)}
                    disabled={!mutable}
                    className={clsx(
                      'p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark',
                      mutable && 'hover:bg-expense-soft dark:hover:bg-expense-soft-dark hover:text-expense',
                      !mutable && 'opacity-40 cursor-not-allowed',
                    )}
                    title={mutable ? '删除' : '服务端暂未提供分类删除接口'}
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
  );
}

// ──────────── 表单模态 ────────────

const COLOR_OPTIONS = [
  '#f97316',
  '#fb923c',
  '#10b981',
  '#0ea5e9',
  '#6366f1',
  '#a855f7',
  '#ec4899',
  '#ef4444',
  '#f59e0b',
  '#6b7280',
];

const ICON_OPTIONS = [
  '🍱', '🥡', '☕', '🍻',
  '🚌', '🚖', '⛽', '🅿️',
  '🛒', '👕', '💄', '💻',
  '🏠', '🏦', '💡', '🎬',
  '🎮', '🏃', '✈️', '🏥',
  '💊', '🛡️', '📚', '🎓',
  '📱', '📺', '🎁', '💸',
  '💰', '🎉', '🧰', '📈',
  '💵', '🎯', '🛍️', '🐶',
];

interface CategoryFormModalProps {
  open: boolean;
  category?: Category;
  /** 创建时所在分组（编辑模式从 category.group 取） */
  group?: string;
  onClose: () => void;
  onSaved?: () => void;
}

function CategoryFormModal({
  open,
  category,
  group,
  onClose,
  onSaved,
}: CategoryFormModalProps) {
  const isEdit = !!category;
  const [name, setName] = useState('');
  const [type, setType] = useState<CategoryType>('expense');
  const [icon, setIcon] = useState('🎯');
  const [color, setColor] = useState(COLOR_OPTIONS[0]);
  const [groupName, setGroupName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(category?.name ?? '');
    setType((category?.type as CategoryType) ?? 'expense');
    setIcon(category?.icon ?? '🎯');
    setColor(category?.color ?? COLOR_OPTIONS[0]);
    setGroupName(category?.group ?? group ?? '');
    setError(null);
  }, [open, category, group]);

  async function save() {
    const nm = name.trim();
    const grp = groupName.trim();
    if (!nm) {
      setError('请填写分类名');
      return;
    }
    if (!grp) {
      setError('请填写分组名');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: nm,
        type,
        icon,
        color,
        group: grp,
      };
      if (isEdit && category?.id != null) {
        // core 未提供 PUT /api/categories/:id，编辑入口已在表格中禁用
        setError('服务端暂未提供分类更新接口');
        return;
      }
      await apiFetch('/api/categories', 'POST', payload);
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
      title={isEdit ? '编辑分类' : '新建分类'}
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
        <Row label="名称" required>
          <Input
            className={FIELD_INPUT_CLS}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：日常餐饮"
            maxLength={20}
          />
        </Row>
        <Row label="分组" required>
          <Input
            className={FIELD_INPUT_CLS}
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
            placeholder="例如：餐饮"
            maxLength={20}
          />
        </Row>
        <Row label="类型" required>
          <Select
            value={type}
            options={[
              { label: '支出', value: 'expense' },
              { label: '收入', value: 'income' },
            ]}
            onChange={(e) => setType(e.target.value as CategoryType)}
          />
        </Row>
        <Row label="图标">
          <div className="flex flex-wrap gap-1.5 p-2 rounded-xl border border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark max-h-[120px] overflow-y-auto">
            {ICON_OPTIONS.map((emo) => (
              <button
                key={emo}
                type="button"
                onClick={() => setIcon(emo)}
                className={clsx(
                  'w-8 h-8 rounded-lg text-lg flex items-center justify-center transition',
                  icon === emo
                    ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                    : 'hover:bg-bg dark:hover:bg-bg-card-dark',
                )}
              >
                {emo}
              </button>
            ))}
          </div>
        </Row>
        <Row label="颜色">
          <div className="flex flex-wrap gap-2">
            {COLOR_OPTIONS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={clsx(
                  'w-6 h-6 rounded-full transition',
                  color === c
                    ? 'ring-2 ring-text dark:ring-bg-card ring-offset-2 ring-offset-bg-card dark:ring-offset-bg-card-dark'
                    : '',
                )}
                style={{ backgroundColor: c }}
                aria-label={c}
              />
            ))}
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

// ──────────── 删除确认 ────────────

function DeleteCategoryModal({
  category,
  onClose,
}: {
  category: Category | null;
  onClose: () => void;
}) {
  // core 未提供 DELETE /api/categories/:id：入口在表格中禁用，这里仅兜底文案。
  return (
    <Modal
      open={!!category}
      onClose={onClose}
      title="删除分类"
      width={420}
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="text-sm space-y-2 text-text dark:text-text-dark">
        <div>
          确定要删除分类「
          <span className="font-medium">{category?.name || '—'}</span> 」吗？
        </div>
        <div className="text-xs text-text-muted dark:text-text-muted-dark">
          该分类下的已有流水仍会保留，但「分类」字段将变为空。
        </div>
        <div className="text-xs text-expense">
          当前服务端（core）尚未提供分类删除接口，此操作暂不可用。
        </div>
      </div>
    </Modal>
  );
}