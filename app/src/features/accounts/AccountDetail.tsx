/**
 * 账户详情页 /account/detail/:id
 *
 * 展示账户信息 + 关联流水，支持编辑 / 删除。
 */
import { useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import type { Account, Transaction, TransactionType, Tag } from '@/db';
import { apiFetch, useApi } from '@/hooks/useApi';
import { toAccount, toTransactions, type RestAccount, type RestTransaction } from './rest';
import { formatMoney, balanceToneClass } from './format';
import {
  ACCOUNT_TONE_BG,
  ACCOUNT_TYPE_META,
  renderTypeIcon,
} from './metadata';
import { AccountFormModal } from './AccountFormModal';
import { DeleteConfirmModal } from '@/features/shared/DeleteConfirmModal';

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
  const validId = Number.isFinite(accountId);

  // core 未提供 GET /api/accounts/:id，这里拉列表后按 id 定位。
  const {
    data: allAccounts,
    loading: loadingAccount,
    error: accountError,
    refetch: refetchAccount,
  } = useApi<RestAccount[]>(validId ? '/api/accounts' : null, [accountId]);

  const account = useMemo<Account | null>(() => {
    if (!validId) return null;
    const row = (allAccounts ?? []).find((a) => a.id === accountId);
    return row ? toAccount(row) : null;
  }, [allAccounts, accountId, validId]);

  // 后端 accountId 参数已覆盖 (accountId = ? OR toAccountId = ?)，并按 date DESC 排序。
  const { data: txRows, loading: loadingTx } = useApi<RestTransaction[]>(
    validId ? `/api/transactions?accountId=${accountId}` : null,
    [accountId],
  );
  const transactions: Transaction[] = useMemo(() => toTransactions(txRows), [txRows]);

  const { data: tags } = useApi<Tag[]>('/api/tags');

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const tagMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of tags ?? []) if (t.id != null) m.set(t.id, t.name);
    return m;
  }, [tags]);

  const headerActions = (
    <Button
      variant="ghost"
      icon={<IconArrowLeft size={16} />}
      onClick={() => navigate('/account/list')}
    >
      返回列表
    </Button>
  );

  if (!validId) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="账户不存在"
          icon={<IconWallet size={18} />}
          actions={headerActions}
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted dark:text-text-muted-dark">该账户已被删除或不存在。</div>
      </div>
    );
  }

  if (accountError) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="账户详情"
          icon={<IconWallet size={18} />}
          actions={headerActions}
        />
        <div className="p-4 lg:p-8 text-sm text-danger dark:text-danger-dark">加载失败：{accountError}</div>
      </div>
    );
  }

  if (loadingAccount || account === null) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title={account === null && !loadingAccount ? '账户不存在' : '账户详情'}
          icon={<IconWallet size={18} />}
          actions={headerActions}
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted dark:text-text-muted-dark">
          {account === null && !loadingAccount ? '该账户已被删除或不存在。' : '加载中…'}
        </div>
      </div>
    );
  }

  const isDebt = account.type === 'credit' || account.type === 'debt';
  const meta = ACCOUNT_TYPE_META[account.type];

  async function handleDelete() {
    if (!account?.id) return;
    setDeleteError(null);
    try {
      // 后端返回 204 无响应体；apiFetch 解析空 body 会抛错，但删除本身已生效。
      await apiFetch(`/api/accounts/${account.id}`, 'DELETE');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('Unexpected end of JSON') && !msg.includes('Unexpected token')) {
        setDeleteError(`删除失败：${msg}`);
        return;
      }
    }
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
              <div className="text-xs text-text-muted dark:text-text-muted-dark">当前余额</div>
              <div
                className={clsx(
                  'mt-2 text-3xl font-medium tabular-nums',
                  balanceToneClass(account.balance),
                )}
              >
                {formatMoney(isDebt ? Math.abs(account.balance) : account.balance)}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge tone={isDebt ? 'expense' : 'income'}>{meta.label}</Badge>
                {(account.tagIds ?? []).map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center px-2 h-5 rounded-md text-xs bg-bg dark:bg-bg-card-dark text-text-muted dark:text-text-muted-dark"
                  >
                    {tagMap.get(id) ?? `#${id}`}
                  </span>
                ))}
                {!account.includeInNetAsset && (
                  <Badge tone="warning">不计入净资产</Badge>
                )}
              </div>
            </div>
            <div className="text-xs text-text-muted dark:text-text-muted-dark min-w-[200px]">
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
              <div className="text-xs text-text-muted dark:text-text-muted-dark mb-1">备注</div>
              <div className="text-sm whitespace-pre-wrap">{account.remark}</div>
            </div>
          )}
        </div>

        {/* 关联流水 */}
        <div className="card !p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="section-title">关联流水</h3>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">
              共 {loadingTx ? '…' : transactions.length} 条
            </div>
          </div>

          {loadingTx ? (
            <div className="py-10 text-center text-sm text-text-muted dark:text-text-muted-dark">加载中…</div>
          ) : transactions.length === 0 ? (
            <div className="py-10 text-center text-sm text-text-muted dark:text-text-muted-dark">
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
              {transactions.map((t) => (
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
        onSaved={refetchAccount}
      />
      <DeleteConfirmModal
        open={deleteOpen}
        title="删除账户"
        message={
          <>
            确定要删除账户「
            <span className="font-medium">{account.name}</span>
            」吗？此操作不可撤销。
          </>
        }
        warning={
          transactions.length > 0 ? (
            <>
              该账户下有{' '}
              <span className="font-medium tabular-nums">{transactions.length}</span>{' '}
              条关联流水，删除后这些流水将失去账户归属。
            </>
          ) : undefined
        }
        errorMessage={deleteError}
        onClose={() => {
          setDeleteError(null);
          setDeleteOpen(false);
        }}
        onConfirm={handleDelete}
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
              : 'bg-bg dark:bg-bg-card-dark text-text-muted dark:text-text-muted-dark',
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
        <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-2 flex-wrap">
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
          tone === 'neutral' && 'text-text-muted dark:text-text-muted-dark',
        )}
      >
        {sign}
        {formatMoney(tx.amount, false)}
      </div>
    </li>
  );
}
