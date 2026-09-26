/**
 * 预算列表页 /budget
 *
 * - URL `?create=1` 自动打开新建模态
 * - 空状态：引导新建
 * - 列表：卡片网格，展示本期已花（实时聚合 transactions）、进度、剩余、超支红色警示
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconCirclePlus,
  IconEye,
  IconShare,
  IconTrash,
  IconPencil,
  IconAlertTriangle,
} from '@tabler/icons-react';
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
  ProgressBar,
} from '@/components/ui';
import { db, type Budget, type Category, type Transaction, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { BudgetFormModal } from './BudgetFormModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { formatMoney, periodLabel, periodRange } from './format';

export default function BudgetList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);

  const budgetsAll = useLiveQuery(
    () => db.budgets.orderBy('createdAt').toArray(),
    [],
  ) as Budget[] | undefined;
  const categories = useLiveQuery(
    () => db.categories.toArray(),
    [],
  ) as Category[] | undefined;
  const transactionsAll = useLiveQuery(
    () => db.transactions.toArray(),
    [],
  ) as Transaction[] | undefined;
  const spaceId = useSpaceId();
  const budgets = useMemo(
    () => filterBySpace(budgetsAll ?? [], spaceId),
    [budgetsAll, spaceId],
  );
  const transactions = useMemo(
    () => filterBySpace(transactionsAll ?? [], spaceId),
    [transactionsAll, spaceId],
  );

  // ?create=1 自动打开新建模态
  useEffect(() => {
    if (searchParams.get('create') === '1') {
      setCreateOpen(true);
      const next = new URLSearchParams(searchParams);
      next.delete('create');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const categoryMap = useMemo(() => {
    const m = new Map<number, Category>();
    for (const c of categories ?? []) if (c.id != null) m.set(c.id, c);
    return m;
  }, [categories]);

  const budgetCount = budgets.length;
  const isEmpty = budgetCount === 0;

  // 按 (period, categoryId) 缓存支出聚合；预算卡片渲染时直接读取
  const spentByKey = useMemo(() => {
    const map = new Map<string, number>();
    const txList = transactions ?? [];
    const now = new Date();
    // 三个期间都算一遍很轻量
    const ranges = {
      monthly: periodRange('monthly', now),
      yearly: periodRange('yearly', now),
    };
    const setKey = (b: Budget, range: { from: number; to: number }) => {
      const cid = b.categoryId ?? 0;
      return `${b.period}:${cid}:${range.from}`;
    };
    const buckets: Array<{ b: Budget; from: number; to: number }> = [];
    for (const b of budgets) {
      const r = ranges[b.period];
      buckets.push({ b, from: r.from, to: r.to });
    }
    for (const t of txList) {
      if (t.type !== 'expense') continue;
      for (const { b, from, to } of buckets) {
        if (t.date < from || t.date >= to) continue;
        if (b.categoryId != null && t.categoryId !== b.categoryId) continue;
        const k = setKey(b, { from, to });
        map.set(k, (map.get(k) ?? 0) + t.amount);
      }
    }
    return map;
  }, [budgets, transactions]);

  async function handleDeleteConfirm() {
    if (!deleting?.id) return;
    await db.budgets.delete(deleting.id);
    setDeleting(null);
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="预算管理"
        description="为分类或整体支出设定月度 / 年度上限"
        icon={<IconCirclePlus size={18} />}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-text-muted">
              <IconEye size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
              <IconShare size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
            </div>
            {!isEmpty && (
              <Button
                icon={<IconCirclePlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建预算
              </Button>
            )}
          </div>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {isEmpty ? (
          <Card>
            <EmptyState
              title="创建预算"
              description="为高频分类或整体支出设定月度 / 年度上限，实时跟踪花费进度，超支会自动红色警示"
              action={
                <Button
                  icon={<IconCirclePlus size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  新建预算
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
            {(budgets).map((b) => {
              const range = periodRange(b.period);
              const key = `${b.period}:${b.categoryId ?? 0}:${range.from}`;
              const spent = spentByKey.get(key) ?? 0;
              return (
                <BudgetCard
                  key={b.id}
                  budget={b}
                  category={
                    b.categoryId != null
                      ? categoryMap.get(b.categoryId)
                      : undefined
                  }
                  spent={spent}
                  onEdit={() => setEditing(b)}
                  onDelete={() => setDeleting(b)}
                />
              );
            })}
          </div>
        )}
      </div>

      <BudgetFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <BudgetFormModal
        open={!!editing}
        budget={editing ?? undefined}
        onClose={() => setEditing(null)}
      />
      <DeleteConfirmModal
        open={!!deleting}
        title="删除预算"
        message={
          <>
            确定要删除预算「
            <span className="font-medium">{deleting?.name}</span>
            」吗？此操作不可撤销。
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

/* ───────────────────── 单张预算卡片 ───────────────────── */

interface BudgetCardProps {
  budget: Budget;
  category?: Category;
  spent: number;
  onEdit: () => void;
  onDelete: () => void;
}

function BudgetCard({ budget, category, spent, onEdit, onDelete }: BudgetCardProps) {
  const pct = budget.amount > 0 ? (spent / budget.amount) * 100 : 0;
  const safePct = Math.max(0, Math.min(100, pct));
  const overspent = spent > budget.amount && budget.amount > 0;
  const remaining = budget.amount - spent;
  const tone = overspent ? 'expense' : 'income';

  return (
    <div className="card !p-5 flex flex-col gap-4 hover:shadow-md transition">
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-none"
            style={{
              background: category?.color ? `${category.color}22` : '#6366f122',
              color: category?.color ?? '#6366f1',
            }}
          >
            {category?.icon ?? '🎯'}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{budget.name}</div>
            <div className="mt-0.5 text-xs text-text-muted flex items-center gap-1.5 truncate">
              <span>{category ? category.name : '总预算'}</span>
              <span>·</span>
              <span>{periodLabel(budget.period)}</span>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-none">
          <button
            type="button"
            onClick={onEdit}
            className="p-1.5 rounded-lg text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark"
            aria-label="编辑"
          >
            <IconPencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 rounded-lg text-text-muted hover:text-expense hover:bg-bg dark:hover:bg-bg-card-dark"
            aria-label="删除"
          >
            <IconTrash size={14} />
          </button>
        </div>
      </div>

      {/* 进度区 */}
      <div>
        <div className="flex items-baseline justify-between mb-1.5">
          <div>
            <span
              className={clsx(
                'text-xl font-medium tabular-nums',
                overspent ? 'text-expense' : 'text-text dark:text-text-dark',
              )}
            >
              {formatMoney(spent, false)}
            </span>
            <span className="ml-1 text-xs text-text-muted">
              / {formatMoney(budget.amount, false)}
            </span>
          </div>
          <div
            className={clsx(
              'text-sm tabular-nums',
              overspent ? 'text-expense' : 'text-text-muted',
            )}
          >
            {pct.toFixed(0)}%
          </div>
        </div>
        <ProgressBar value={safePct} tone={tone} size="md" />
      </div>

      {/* 元信息 */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-text-muted">关联分类</div>
          <div className="mt-0.5 font-medium truncate">
            {category ? `${category.group} · ${category.name}` : '总预算（全部支出）'}
          </div>
        </div>
        <div>
          <div className="text-text-muted">
            {overspent ? '已超支' : '剩余'}
          </div>
          <div
            className={clsx(
              'mt-0.5 font-medium tabular-nums',
              overspent ? 'text-expense' : 'text-text dark:text-text-dark',
            )}
          >
            {formatMoney(Math.abs(remaining), false)}
          </div>
        </div>
      </div>

      {overspent && (
        <div className="flex items-center gap-1.5 text-xs text-expense">
          <IconAlertTriangle size={12} />
          <span>已超出预算 {formatMoney(spent - budget.amount, false)}</span>
        </div>
      )}
    </div>
  );
}