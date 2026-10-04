/**
 * 目标列表页 /goal/list
 *
 * - URL `?create=1` 自动打开新建模态
 * - 空状态：引导新建
 * - 列表：卡片网格，每张卡片展示进度 / 截止 / 快捷"存入/取出" / 编辑 / 删除
 */
import { useEffect, useMemo, useState, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import clsx from 'clsx';
import {
  IconTarget,
  IconPlus,
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
import { type Account, type Goal, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { useApi } from '@/hooks/useApi';
import { GoalFormModal } from './GoalFormModal';
import { GoalAmountModal } from './GoalAmountModal';
import { DeleteConfirmModal } from '@/features/shared/DeleteConfirmModal';
import { deadlineText, formatMoney } from './format';
import { kindLabel } from './metadata';

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

export default function GoalList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [amountTarget, setAmountTarget] = useState<{
    goal: Goal;
    mode: 'deposit' | 'withdraw';
  } | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 全局写操作版本号：任一增删改成功后自增，驱动列表与下拉数据重新拉取 */
  const [version, setVersion] = useState(0);
  const bumpVersion = useCallback(() => setVersion((v) => v + 1), []);

  const spaceId = useSpaceId();
  // spaceId === 0 表示"全部空间"，此时不拼 spaceId 让服务端返回全量
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;

  const { data: goalsAll, loading } = useApi<Goal[]>(`/api/goals${spaceQ}`, [version]);
  const { data: accountsAll } = useApi<Account[]>(`/api/accounts${spaceQ}`, [version]);
  const goals = useMemo(
    () => filterBySpace(goalsAll ?? [], spaceId),
    [goalsAll, spaceId],
  );
  const accounts = useMemo(
    () => filterBySpace(accountsAll ?? [], spaceId),
    [accountsAll, spaceId],
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

  const accountMap = useMemo(() => {
    const m = new Map<number, Account>();
    for (const a of accounts ?? []) if (a.id != null) m.set(a.id, a);
    return m;
  }, [accounts]);

  const goalCount = goals.length;
  // loading 期间不算空，否则每次进页面都先闪一帧"创建目标"
  const isEmpty = !loading && goalCount === 0;

  async function handleDeleteConfirm() {
    if (!deleting?.id) return;
    try {
      // 账户余额贡献由 core 在删除时一并回滚
      await apiDelete(`/api/goals/${deleting.id}`);
      setDeleting(null);
      bumpVersion();
    } catch (e) {
      setError((e as Error).message ?? '删除失败');
    }
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="目标管理"
        icon={<IconTarget size={18} />}
        actions={
          <Button
            icon={<IconPlus size={16} />}
            onClick={() => setCreateOpen(true)}
          >
            新建目标
          </Button>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {loading ? (
          <div
            className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4"
            data-testid="goal-loading"
          >
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-40 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyStateCard
            title="创建目标"
            description="目标助你实现财务梦想，例如购房首付、应急基金、旅行储蓄、教育基金等"
            action={
              <Button
                variant="secondary"
                icon={<IconPlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建目标
              </Button>
            }
          />
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {goals.map((g) => (
              <GoalCard
                key={g.id}
                goal={g}
                account={
                  g.accountId != null ? accountMap.get(g.accountId) : undefined
                }
                onDeposit={() => setAmountTarget({ goal: g, mode: 'deposit' })}
                onWithdraw={() => setAmountTarget({ goal: g, mode: 'withdraw' })}
                onEdit={() => setEditing(g)}
                onDelete={() => setDeleting(g)}
              />
            ))}
          </div>
        )}
      </div>

      <GoalFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        version={version}
        onSaved={bumpVersion}
      />
      <GoalFormModal
        open={!!editing}
        goal={editing ?? undefined}
        onClose={() => setEditing(null)}
        version={version}
        onSaved={bumpVersion}
      />
      <GoalAmountModal
        open={!!amountTarget}
        goal={amountTarget?.goal ?? null}
        mode={amountTarget?.mode ?? 'deposit'}
        account={
          amountTarget?.goal?.accountId != null
            ? accountMap.get(amountTarget.goal.accountId)
            : undefined
        }
        onClose={() => setAmountTarget(null)}
        onChanged={bumpVersion}
      />
      {error && (
        <div className="mx-4 lg:mx-8 mb-4 text-sm text-danger dark:text-danger-dark bg-danger-soft dark:bg-danger-soft-dark rounded-xl px-3 py-2">
          {error}
        </div>
      )}
      <DeleteConfirmModal
        open={!!deleting}
        title="删除目标"
        message={
          <>
            确定要删除目标「
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

/* ───────────────────── 目标卡片 ───────────────────── */

interface GoalCardProps {
  goal: Goal;
  account?: Account;
  onDeposit: () => void;
  onWithdraw: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function GoalCard({
  goal,
  account,
  onDeposit,
  onWithdraw,
  onEdit,
  onDelete,
}: GoalCardProps) {
  const pct =
    goal.targetAmount > 0 ? (goal.currentAmount / goal.targetAmount) * 100 : 0;
  const safePct = Math.max(0, Math.min(100, pct));
  const isRepayment = goal.kind === 'repayment';
  const progressTone = isRepayment ? 'expense' : 'income';
  const reached = goal.currentAmount >= goal.targetAmount && goal.targetAmount > 0;
  const overdue = goal.deadline != null && goal.deadline < Date.now() && !reached;

  return (
    <div className="card !p-5 flex flex-col gap-4">
      {/* 标题行 */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-none"
            style={{
              background: `${goal.color ?? '#10b981'}22`,
              color: goal.color ?? '#10b981',
            }}
          >
            {goal.icon ?? (goal.kind === 'saving' ? '💰' : '💳')}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{goal.name}</div>
            <div className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1.5">
              {goal.subtype && <span>{goal.subtype}</span>}
              {goal.subtype && <span>·</span>}
              <span>{kindLabel(goal.kind)}</span>
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
                isRepayment ? 'text-expense' : 'text-income',
              )}
            >
              {formatMoney(goal.currentAmount, false)}
            </span>
            <span className="ml-1 text-xs text-text-muted dark:text-text-muted-dark">
              / {formatMoney(goal.targetAmount, false)}
            </span>
          </div>
          <div className="text-sm text-text-muted dark:text-text-muted-dark tabular-nums">
            {pct.toFixed(0)}%
          </div>
        </div>
        <ProgressBar value={safePct} tone={progressTone} size="md" />
      </div>

      {/* 元信息 */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-text-muted dark:text-text-muted-dark">截止</div>
          <div
            className={clsx(
              'mt-0.5 font-medium',
              overdue ? 'text-expense' : 'text-text dark:text-text-dark',
            )}
          >
            {deadlineText(goal.deadline)}
          </div>
        </div>
        <div>
          <div className="text-text-muted dark:text-text-muted-dark">关联账户</div>
          <div className="mt-0.5 font-medium truncate">
            {account?.name ?? '未关联'}
          </div>
        </div>
      </div>

      {overdue && (
        <div className="flex items-center gap-1.5 text-xs text-expense">
          <IconAlertTriangle size={12} />
          <span>截止日期已过，请调整计划</span>
        </div>
      )}
      {reached && !isRepayment && (
        <div className="text-xs text-income">已达成 🎉</div>
      )}

      {/* 快捷操作 */}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={onDeposit}
          disabled={overdue && !reached}
        >
          存入
        </Button>
        <Button
          variant="secondary"
          size="sm"
          block
          onClick={onWithdraw}
          disabled={goal.currentAmount <= 0}
        >
          取出
        </Button>
      </div>
    </div>
  );
}
