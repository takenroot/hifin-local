/**
 * 目标列表页 /goal/list
 *
 * - URL `?create=1` 自动打开新建模态
 * - 空状态：引导新建
 * - 列表：卡片网格，每张卡片展示进度 / 截止 / 快捷"存入/取出" / 编辑 / 删除
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconTarget,
  IconPlus,
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
import { db, type Account, type Goal, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { GoalFormModal } from './GoalFormModal';
import { GoalAmountModal } from './GoalAmountModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { deadlineText, formatMoney } from './format';
import { kindLabel } from './metadata';

export default function GoalList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Goal | null>(null);
  const [amountTarget, setAmountTarget] = useState<{
    goal: Goal;
    mode: 'deposit' | 'withdraw';
  } | null>(null);
  const [deleting, setDeleting] = useState<Goal | null>(null);

  const goalsAll = useLiveQuery(
    () => db.goals.orderBy('createdAt').toArray(),
    [],
  );
  const accountsAll = useLiveQuery(() => db.accounts.toArray(), []);
  const spaceId = useSpaceId();
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
  const isEmpty = goalCount === 0;

  async function handleDeleteConfirm() {
    if (!deleting?.id) return;
    await db.goals.delete(deleting.id);
    setDeleting(null);
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="目标管理"
        icon={<IconTarget size={18} />}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-text-muted">
              <IconEye size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
              <IconShare size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
            </div>
            {!isEmpty && (
              <Button
                icon={<IconPlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建目标
              </Button>
            )}
          </div>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {isEmpty ? (
          <Card>
            <EmptyState
              title="创建目标"
              description="目标助你实现财务梦想，例如购房首付、应急基金、旅行储蓄、教育基金等"
              action={
                <Button
                  icon={<IconPlus size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  新建目标
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
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
      />
      <GoalFormModal
        open={!!editing}
        goal={editing ?? undefined}
        onClose={() => setEditing(null)}
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
      />
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
    <div className="card !p-5 flex flex-col gap-4 hover:shadow-md transition">
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
            <div className="mt-0.5 text-xs text-text-muted flex items-center gap-1.5">
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
                isRepayment ? 'text-expense' : 'text-income',
              )}
            >
              {formatMoney(goal.currentAmount, false)}
            </span>
            <span className="ml-1 text-xs text-text-muted">
              / {formatMoney(goal.targetAmount, false)}
            </span>
          </div>
          <div className="text-sm text-text-muted tabular-nums">
            {pct.toFixed(0)}%
          </div>
        </div>
        <ProgressBar value={safePct} tone={progressTone} size="md" />
      </div>

      {/* 元信息 */}
      <div className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <div className="text-text-muted">截止</div>
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
          <div className="text-text-muted">关联账户</div>
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
