/**
 * 预算列表页 /budget
 *
 * - URL `?create=1` 自动打开新建模态
 * - 空状态：引导新建
 * - 列表：卡片网格，展示本期已花、进度、剩余、超支红色警示
 *
 * 「本期已花」由前端聚合：core 暂无 budget-spent 端点，因此拉取当前空间的
 * 支出流水后按 (period, categoryId) 在本地求和。
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  IconCirclePlus,
  IconTrash,
  IconPencil,
  IconAlertTriangle,
} from '@tabler/icons-react';
import {
  Button,
  EmptyStateCard,
  PageHeader,
  ProgressBar,
} from '@/components/ui';
import { type Budget, type Category, useSpaceId } from '@/db';
import { filterBySpace, type SpaceAware } from '@/space';
import { useApi } from '@/hooks/useApi';
import { BudgetFormModal } from './BudgetFormModal';
import { DeleteConfirmModal } from '@/features/shared/DeleteConfirmModal';
import { formatMoney, periodLabel, periodRange } from './format';

/** 已花聚合只需要这几个字段；categoryId 在 SQLite 里可空。 */
interface ExpenseRow extends SpaceAware {
  type: string;
  amount: number;
  date: number;
  categoryId?: number | null;
}

/**
 * DELETE 助手：core 的 DELETE 返回 204 空响应体，而 apiFetch 假定响应是 JSON，
 * 成功路径反而会在 r.json() 上抛错，因此删除操作不能走 apiFetch。
 */
async function apiDelete(url: string): Promise<void> {
  const r = await fetch(url, { method: 'DELETE' });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
}

export default function BudgetList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Budget | null>(null);
  const [deleting, setDeleting] = useState<Budget | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 全局写操作版本号：任一增删改成功后自增，驱动列表与已花聚合重新拉取 */
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  const spaceId = useSpaceId();
  // spaceId === 0 表示"全部空间"，此时不拼 spaceId 让服务端返回全量
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;

  const { data: budgetsAll, loading } = useApi<Budget[]>(`/api/budgets${spaceQ}`, [version]);
  const { data: categories } = useApi<Category[]>('/api/categories', [version]);
  // 已花只需支出；服务端已按 spaceId + type 过滤，减少传输量
  const { data: expenses } = useApi<ExpenseRow[]>(
    `/api/transactions${spaceQ}${spaceQ ? '&' : '?'}type=expense`,
    [version],
  );

  const budgets = useMemo(
    () => filterBySpace(budgetsAll ?? [], spaceId),
    [budgetsAll, spaceId],
  );
  const transactions = useMemo(
    () => filterBySpace(expenses ?? [], spaceId),
    [expenses, spaceId],
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
  // loading 期间不算空，否则每次进页面都先闪一帧"创建预算"
  const isEmpty = !loading && budgetCount === 0;

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
    try {
      await apiDelete(`/api/budgets/${deleting.id}`);
      setDeleting(null);
      bumpVersion();
    } catch (e) {
      setError((e as Error).message ?? '删除失败');
    }
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="预算管理"
        description="为分类或整体支出设定月度 / 年度上限"
        icon={<IconCirclePlus size={18} />}
        actions={
          <Button
            icon={<IconCirclePlus size={16} />}
            onClick={() => setCreateOpen(true)}
          >
            新建预算
          </Button>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {loading ? (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4"
            data-testid="budget-loading"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyStateCard
            title="创建预算"
            description="为高频分类或整体支出设定月度 / 年度上限，实时跟踪花费进度，超支会自动红色警示"
            action={
              <Button
                variant="secondary"
                icon={<IconCirclePlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建预算
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
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
        version={version}
        onSaved={bumpVersion}
      />
      <BudgetFormModal
        open={!!editing}
        budget={editing ?? undefined}
        onClose={() => setEditing(null)}
        version={version}
        onSaved={bumpVersion}
      />
      {error && (
        <div className="mx-4 lg:mx-8 mb-4 text-sm text-danger dark:text-danger-dark bg-danger-soft dark:bg-danger-soft-dark rounded-xl px-3 py-2">
          {error}
        </div>
      )}
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
  // 超支是异常状态，用红色 text-income 报警；未超支时"已花"属支出，用绿色 text-expense。
  const tone = overspent ? 'income' : 'expense';

  return (
    <div data-testid="budget-card" className="card !p-5 flex flex-col gap-4 transition">
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-none"
            style={{
              // ponytail: 无分类色时回退中性灰（text-muted #6b7280），不用已废的靛蓝
              background: category?.color ? `${category.color}22` : 'rgba(107,114,128,0.13)',
              color: category?.color ?? '#6b7280',
            }}
          >
            {category?.icon ?? '🎯'}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{budget.name}</div>
            <div className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1.5 truncate">
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
            className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark"
            aria-label="编辑"
          >
            <IconPencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            className="p-1.5 rounded-lg text-text-muted dark:text-text-muted-dark hover:text-danger dark:text-danger-dark hover:bg-bg dark:hover:bg-bg-card-dark"
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
                overspent ? 'text-income' : 'text-expense',
              )}
            >
              {formatMoney(spent, false)}
            </span>
            <span className="ml-1 text-xs text-text-muted dark:text-text-muted-dark">
              / {formatMoney(budget.amount, false)}
            </span>
          </div>
          <div
            className={clsx(
              'text-sm tabular-nums',
              overspent ? 'text-income' : 'text-text-muted dark:text-text-muted-dark',
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
          <div className="text-text-muted dark:text-text-muted-dark">关联分类</div>
          <div className="mt-0.5 font-medium truncate">
            {category ? `${category.group} · ${category.name}` : '总预算（全部支出）'}
          </div>
        </div>
        <div>
          <div className={clsx('text-text-muted dark:text-text-muted-dark', overspent && 'text-income')}>
            {overspent ? '已超支' : '剩余'}
          </div>
          <div
            className={clsx(
              'mt-0.5 font-medium tabular-nums',
              overspent ? 'text-income' : 'text-text dark:text-text-dark',
            )}
          >
            {formatMoney(Math.abs(remaining), false)}
          </div>
        </div>
      </div>

      {overspent && (
        <div className="flex items-center gap-1.5 text-xs text-income">
          <IconAlertTriangle size={12} />
          <span>已超出预算 {formatMoney(spent - budget.amount, false)}</span>
        </div>
      )}
    </div>
  );
}