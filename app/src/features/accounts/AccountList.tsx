/**
 * 账户列表页 /account/list
 *
 * - 空数据：展示 EmptyState，引导新建账户
 * - 有数据：按"资产 / 负债"两个分组，每组卡片网格 + 合计
 * - URL ?create=1 自动打开新建账户两步模态
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconWallet,
  IconPlus,
  IconChevronRight,
} from '@tabler/icons-react';
import {
  Button,
  EmptyState,
  PageHeader,
} from '@/components/ui';
import { db, type Account } from '@/db';
import { useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { formatMoney } from './format';
import {
  ACCOUNT_TONE_BG,
  ACCOUNT_TYPE_META,
  ASSET_TYPES,
  DEBT_TYPES,
  renderTypeIcon,
} from './metadata';
import { AccountFormModal } from './AccountFormModal';

export default function AccountList() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(false);
  const spaceId = useSpaceId();

  const accounts = useLiveQuery(
    () => db.accounts.orderBy('createdAt').toArray(),
    [],
  );

  // 按当前空间过滤；sid=0 不过滤
  const scopedAccounts = useMemo(
    () => filterBySpace(accounts ?? [], spaceId),
    [accounts, spaceId],
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

  const { assets, debts, assetSum, debtSum } = useMemo(() => {
    const list = scopedAccounts;
    const a = list.filter((x) => (ASSET_TYPES as readonly string[]).includes(x.type));
    const d = list.filter((x) => (DEBT_TYPES as readonly string[]).includes(x.type));
    let assetSumAcc = 0;
    let debtSumAcc = 0;
    for (const acc of a) assetSumAcc += acc.balance;
    for (const acc of d) debtSumAcc += Math.abs(acc.balance);
    return {
      assets: a,
      debts: d,
      assetSum: assetSumAcc,
      debtSum: debtSumAcc,
    };
  }, [scopedAccounts]);

  const isEmpty = scopedAccounts.length === 0;

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="账户管理"
        icon={<IconWallet size={18} />}
        actions={
          !isEmpty && (
            <Button
              variant="primary"
              icon={<IconPlus size={16} />}
              onClick={() => setCreateOpen(true)}
            >
              新建账户
            </Button>
          )
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {isEmpty ? (
          <Card>
            <EmptyState
              title="创建账户"
              description={
                <>
                  账户用于管理资产和交易
                  <br />
                  比如：银行账户、支付宝、微信、投资、社保，甚至不动产等
                </>
              }
              action={
                <Button
                  variant="primary"
                  icon={<IconPlus size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  新建账户
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="space-y-8">
            <AccountSection
              title="资产"
              tone="income"
              accounts={assets}
              total={assetSum}
              totalLabel="资产合计"
            />
            <AccountSection
              title="负债"
              tone="expense"
              accounts={debts}
              total={debtSum}
              totalLabel="负债合计"
            />
          </div>
        )}
      </div>

      <AccountFormModal open={createOpen} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card p-0 overflow-hidden">{children}</div>;
}

function AccountSection({
  title,
  tone,
  accounts,
  total,
  totalLabel,
}: {
  title: string;
  tone: 'income' | 'expense';
  accounts: Account[];
  total: number;
  totalLabel: string;
}) {
  if (accounts.length === 0) return null;
  return (
    <section>
      <div className="flex items-end justify-between mb-4">
        <h2 className="section-title">{title}</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-text-muted">{totalLabel}</span>
          <span
            className={clsx(
              'text-lg font-medium tabular-nums',
              tone === 'income' ? 'text-income' : 'text-expense',
            )}
          >
            {formatMoney(total)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {accounts.map((acc) => (
          <AccountCard key={acc.id} account={acc} />
        ))}
      </div>
    </section>
  );
}

function AccountCard({ account }: { account: Account }) {
  const navigate = useNavigate();
  const meta = ACCOUNT_TYPE_META[account.type];
  const isDebt = account.type === 'credit' || account.type === 'debt';
  const tags = useLiveQuery(
    () =>
      account.tagIds && account.tagIds.length > 0
        ? db.tags.where('id').anyOf(account.tagIds).toArray()
        : Promise.resolve([] as { id?: number; name: string }[]),
    [account.tagIds],
  );

  return (
    <button
      type="button"
      onClick={() => navigate(`/account/detail/${account.id}`)}
      className="card !p-5 text-left hover:shadow-md transition group"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className={clsx(
              'w-10 h-10 rounded-xl flex items-center justify-center flex-none',
              ACCOUNT_TONE_BG[account.type],
            )}
          >
            {renderTypeIcon(account.type, 20)}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{account.name}</div>
            <div className="text-xs text-text-muted mt-0.5">{meta.label}</div>
          </div>
        </div>
        <IconChevronRight
          size={16}
          className="text-text-muted opacity-0 group-hover:opacity-100 transition"
        />
      </div>

      <div className="mt-4">
        <div
          className={clsx(
            'text-xl font-medium tabular-nums',
            isDebt ? 'text-expense' : 'text-income',
          )}
        >
          {formatMoney(isDebt ? Math.abs(account.balance) : account.balance)}
        </div>
      </div>

      {(tags?.length ?? 0) > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {(tags ?? []).map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center px-2 h-5 rounded-md text-xs bg-bg dark:bg-bg-card-dark text-text-muted"
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      {!account.includeInNetAsset && (
        <div className="mt-2 text-xs text-text-muted">不计入净资产</div>
      )}
    </button>
  );
}
