/**
 * 账户详情页 /account/detail/:id
 *
 * 展示账户信息 + 关联流水，支持编辑 / 删除。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import dayjs from 'dayjs';
import clsx from 'clsx';
import {
  IconArrowLeft,
  IconPencil,
  IconTrash,
  IconWallet,
  IconArrowsLeftRight,
  IconPlus,
} from '@tabler/icons-react';
import {
  Badge,
  Button,
  PageHeader,
} from '@/components/ui';
import { db, type Account, type Transaction, type TransactionType } from '@/db';
import { formatMoney } from './format';
import {
  ACCOUNT_TONE_BG,
  ACCOUNT_TYPE_META,
  renderTypeIcon,
} from './metadata';
import { AccountFormModal } from './AccountFormModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';

const TYPE_LABEL: Record<TransactionType, string> = {
  expense: '支出',
  income: '收入',
  transfer: '转账',
  excluded: '不计',
};

export default function AccountDetail() {
  const params = useParams<{ id: string }>();
  const accountId = Number(params.id);
  const navigate = useNavigate();

  const account = useLiveQuery<Account | null | undefined>(
    async () => {
      if (!Number.isFinite(accountId)) return null;
      const a = await db.accounts.get(accountId);
      return a ?? null;
    },
    [accountId],
  );

  const transactions = useLiveQuery(
    () =>
      Number.isFinite(accountId)
        ? db.transactions
            .where('accountId')
            .equals(accountId)
            .or('toAccountId')
            .equals(accountId)
            .reverse()
            .sortBy('date')
            .then((arr) => arr.sort((a, b) => b.date - a.date))
        : Promise.resolve([] as Transaction[]),
    [accountId],
  );

  const tags = useLiveQuery(() => db.tags.orderBy('name').toArray(), []);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const tagMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of tags ?? []) if (t.id != null) m.set(t.id, t.name);
    return m;
  }, [tags]);

  if (account === undefined) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="账户详情"
          icon={<IconWallet size={18} />}
          actions={
            <Button
              variant="ghost"
              icon={<IconArrowLeft size={16} />}
              onClick={() => navigate('/account/list')}
            >
              返回列表
            </Button>
          }
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted">加载中…</div>
      </div>
    );
  }

  if (account === null) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="账户不存在"
          icon={<IconWallet size={18} />}
          actions={
            <Button
              variant="ghost"
              icon={<IconArrowLeft size={16} />}
              onClick={() => navigate('/account/list')}
            >
              返回列表
            </Button>
          }
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted">该账户已被删除或不存在。</div>
      </div>
    );
  }

  const isDebt = account.type === 'credit' || account.type === 'debt';
  const meta = ACCOUNT_TYPE_META[account.type];

  async function handleDelete() {
    if (!account?.id) return;
    await db.accounts.delete(account.id);
    setDeleteOpen(false);
    navigate('/account/list');
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title={account.name}
        description={`${meta.label} · 账户详情`}
        icon={
          <span className={clsx('w-7 h-7 rounded-lg flex items-center justify-center', ACCOUNT_TONE_BG[account.type])}>
            {renderTypeIcon(account.type, 16)}
          </span>
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={<IconPencil size={16} />}
              onClick={() => setEditOpen(true)}
            >
              编辑
            </Button>
            <Button
              variant="danger"
              icon={<IconTrash size={16} />}
              onClick={() => setDeleteOpen(true)}
            >
              删除
            </Button>
          </>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1100px] space-y-6">
        {/* 摘要卡 */}
        <div className="card !p-6">
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <div className="text-xs text-text-muted">当前余额</div>
              <div
                className={clsx(
                  'mt-2 text-3xl font-medium tabular-nums',
                  isDebt ? 'text-expense' : 'text-income',
                )}
              >
                {formatMoney(isDebt ? Math.abs(account.balance) : account.balance)}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone={isDebt ? 'expense' : 'income'}>{meta.label}</Badge>
                {(account.tagIds ?? []).map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center px-2 h-5 rounded-md text-xs bg-bg dark:bg-bg-card-dark text-text-muted"
                  >
                    {tagMap.get(id) ?? `#${id}`}
                  </span>
                ))}
                {!account.includeInNetAsset && (
                  <Badge tone="warning">不计入净资产</Badge>
                )}
              </div>
            </div>
            <div className="text-xs text-text-muted min-w-[200px]">
              <div>
                创建时间：
                {dayjs(account.createdAt).format('YYYY-MM-DD HH:mm')}
              </div>
              <div className="mt-1">
                更新时间：
                {dayjs(account.updatedAt).format('YYYY-MM-DD HH:mm')}
              </div>
            </div>
          </div>

          {account.remark && (
            <div className="mt-5 pt-5 border-t border-border dark:border-border-dark">
              <div className="text-xs text-text-muted mb-1">备注</div>
              <div className="text-sm whitespace-pre-wrap">{account.remark}</div>
            </div>
          )}
        </div>

        {/* 关联流水 */}
        <div className="card !p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="section-title">关联流水</h3>
            <div className="text-xs text-text-muted">
              共 {(transactions?.length ?? 0)} 条
            </div>
          </div>

          {(transactions?.length ?? 0) === 0 ? (
            <div className="py-10 text-center text-sm text-text-muted">
              暂无关联流水
              <div className="mt-3">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<IconPlus size={14} />}
                  onClick={() => navigate('/transaction')}
                >
                  前往记录流水
                </Button>
              </div>
            </div>
          ) : (
            <ul className="divide-y divide-border dark:divide-border-dark -mx-2">
              {(transactions ?? []).map((t) => (
                <TransactionRow
                  key={t.id}
                  tx={t}
                  currentAccountId={account.id!}
                  tagMap={tagMap}
                />
              ))}
            </ul>
          )}
        </div>
      </div>

      <AccountFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        account={account}
      />
      <DeleteConfirmModal
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        accountName={account.name}
        relatedCount={transactions?.length ?? 0}
      />
    </div>
  );
}

function TransactionRow({
  tx,
  currentAccountId,
  tagMap,
}: {
  tx: Transaction;
  currentAccountId: number;
  tagMap: Map<number, string>;
}) {
  const isTransfer = tx.type === 'transfer';
  const isIncome = tx.type === 'income';
  const isExpense = tx.type === 'expense';
  // 转账时，如果是转入方则显示正向（绿）；转出则显示负向（红）
  const incoming = isTransfer && tx.toAccountId === currentAccountId;
  const outgoing = isTransfer && tx.accountId === currentAccountId && !incoming;

  const tone: 'income' | 'expense' | 'neutral' = isIncome || incoming
    ? 'income'
    : isExpense || outgoing
      ? 'expense'
      : 'neutral';

  const sign = tone === 'income' ? '+' : tone === 'expense' ? '-' : '';
  const tagIds = tx.tagIds ?? [];

  return (
    <li className="flex items-center gap-3 px-2 py-3">
      <div
        className={clsx(
          'w-8 h-8 rounded-lg flex items-center justify-center flex-none',
          tone === 'income'
            ? 'bg-income-soft dark:bg-income-soft-dark text-income'
            : tone === 'expense'
              ? 'bg-expense-soft dark:bg-expense-soft-dark text-expense'
              : 'bg-bg dark:bg-bg-card-dark text-text-muted',
        )}
      >
        {isTransfer ? <IconArrowsLeftRight size={16} /> : isIncome ? <span>📥</span> : isExpense ? <span>📤</span> : <span>•</span>}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate">{tx.name || TYPE_LABEL[tx.type]}</span>
          <Badge tone={tone === 'income' ? 'income' : tone === 'expense' ? 'expense' : 'neutral'}>
            {TYPE_LABEL[tx.type]}
          </Badge>
        </div>
        <div className="mt-1 text-xs text-text-muted flex items-center gap-2 flex-wrap">
          <span>{dayjs(tx.date).format('YYYY-MM-DD HH:mm')}</span>
          {tagIds.length > 0 && (
            <span>
              {tagIds.map((id) => `#${tagMap.get(id) ?? id}`).join(' ')}
            </span>
          )}
          {!tx.includeInAsset && <Badge tone="warning">不计资产</Badge>}
        </div>
      </div>
      <div
        className={clsx(
          'text-sm font-medium tabular-nums flex-none',
          tone === 'income' && 'text-income',
          tone === 'expense' && 'text-expense',
          tone === 'neutral' && 'text-text-muted',
        )}
      >
        {sign}
        {formatMoney(tx.amount, false)}
      </div>
    </li>
  );
}
