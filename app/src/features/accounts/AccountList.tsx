/**
 * 账户列表页 /account/list
 *
 * - 空数据：展示 EmptyState，引导新建账户
 * - 有数据：按"资产 / 负债"两个分组，每组卡片网格 + 合计
 * - URL ?create=1 自动打开新建账户两步模态
 */
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  IconWallet,
  IconPlus,
  IconChevronRight,
} from '@tabler/icons-react';
import {
  Button,
  EmptyState,
  EmptyStateCard,
  PageHeader,
} from '@/components/ui';
import { useSpaceId } from '@/db';
import type { Account, Tag } from '@/db';
import { useApi } from '@/hooks/useApi';
import { toAccounts, type RestAccount } from './rest';
import { formatMoney, balanceToneClass } from './format';
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

  // 空间过滤直接拼 URL：spaceId=0 表示"全部空间"，不带参数由后端返回全量。
  const spaceQuery = spaceId ? `?spaceId=${spaceId}` : '';
  const { data, loading, error, refetch } = useApi<RestAccount[]>(
    `/api/accounts${spaceQuery}`,
    [spaceId],
  );
  const { data: tags } = useApi<Tag[]>('/api/tags');

  const accounts = useMemo(() => toAccounts(data), [data]);

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
    const list = accounts;
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
  }, [accounts]);

  const isEmpty = accounts.length === 0;

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="账户管理"
        icon={<IconWallet size={18} />}
        actions={
          <Button
            variant="primary"
            icon={<IconPlus size={16} />}
            onClick={() => setCreateOpen(true)}
          >
            新建账户
          </Button>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1400px]">
        {error ? (
          <Card>
            <EmptyState
              title="加载失败"
              description={`无法从服务端读取账户列表：${error}`}
              action={
                <Button variant="primary" onClick={refetch}>
                  重试
                </Button>
              }
            />
          </Card>
        ) : loading ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-40 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyStateCard
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
                variant="secondary"
                icon={<IconPlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建账户
              </Button>
            }
          />
        ) : (
          <div className="space-y-8">
            <AccountSection
              title="资产"
              accounts={assets}
              total={assetSum}
              totalLabel="资产合计"
              tags={tags ?? []}
            />
            <AccountSection
              title="负债"
              accounts={debts}
              total={debtSum}
              totalLabel="负债合计"
              tags={tags ?? []}
            />
          </div>
        )}
      </div>

      <AccountFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={refetch}
      />
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="card p-0 overflow-hidden">{children}</div>;
}

function AccountSection({
  title,
  accounts,
  total,
  totalLabel,
  tags,
}: {
  title: string;
  accounts: Account[];
  total: number;
  totalLabel: string;
  tags: Tag[];
}) {
  if (accounts.length === 0) return null;
  return (
    <section>
      <div className="flex items-end justify-between mb-4">
        <h2 className="section-title">{title}</h2>
        <div className="flex items-baseline gap-2">
          <span className="text-xs text-text-muted dark:text-text-muted-dark">{totalLabel}</span>
          {/* 合计按正负着色：负数（净资产为负）显示绿色，正数显示红色 */}
          <span className={clsx('text-lg font-medium tabular-nums', balanceToneClass(total))}>
            {formatMoney(total)}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {accounts.map((acc) => (
          <AccountCard key={acc.id} account={acc} tags={tags} />
        ))}
      </div>
    </section>
  );
}

function AccountCard({ account, tags }: { account: Account; tags: Tag[] }) {
  const navigate = useNavigate();
  const meta = ACCOUNT_TYPE_META[account.type];
  const isDebt = account.type === 'credit' || account.type === 'debt';
  // 标签随列表一次性拉取（/api/tags），此处按 id 本地关联，避免每张卡片单独请求。
  const accountTags = useMemo(() => {
    const ids = account.tagIds ?? [];
    if (ids.length === 0) return [];
    return tags.filter((t) => t.id != null && ids.includes(t.id));
  }, [account.tagIds, tags]);

  return (
    <button
      type="button"
      onClick={() => navigate(`/account/detail/${account.id}`)}
      className="card !p-5 text-left transition group"
      data-testid="account-card"
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
            <div className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">{meta.label}</div>
          </div>
        </div>
        <IconChevronRight
          size={16}
          className="text-text-muted dark:text-text-muted-dark opacity-0 group-hover:opacity-100 transition"
        />
      </div>

      <div className="mt-4">
        {/* 余额按正负着色：负债类账户仍取绝对值展示，负余额显示绿色 */}
        <div className={clsx('text-xl font-medium tabular-nums', balanceToneClass(account.balance))}>
          {formatMoney(isDebt ? Math.abs(account.balance) : account.balance)}
        </div>
      </div>

      {accountTags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {accountTags.map((t) => (
            <span
              key={t.id}
              className="inline-flex items-center px-2 h-5 rounded-md text-xs bg-bg dark:bg-bg-card-dark text-text-muted dark:text-text-muted-dark"
            >
              {t.name}
            </span>
          ))}
        </div>
      )}

      {!account.includeInNetAsset && (
        <div className="mt-2 text-xs text-text-muted dark:text-text-muted-dark">不计入净资产</div>
      )}
    </button>
  );
}
