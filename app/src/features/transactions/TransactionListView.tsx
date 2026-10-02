/**
 * 交易列表视图（按日分组 + 筛选 + 行内编辑 / 删除）
 * - 暗色约定：所有 muted / hover 底色都要配 dark: 变体；
 *   动态颜色（分类色、标签色）无色时回落到 muted token，不写死浅色灰。
 */
import { useMemo } from 'react';
import dayjs from 'dayjs';
import {
  IconArrowsLeftRight,
  IconPencil,
  IconTrash,
  IconWallet,
  IconReceipt,
  IconEyeOff,
  IconTag,
  IconBuildingStore,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  type Transaction,
  type Category,
  type Account,
  type Tag,
  type Merchant,
  useSpaceId,
} from '@/db';
import { filterBySpace } from '@/space';
import { useApi } from '@/hooks/useApi';
import { EmptyState } from '@/components/ui';
import { applyFilter, summarize, type TxFilter } from './balance';
import { formatMoney, groupKey } from './format';
import { apiDelete, toTransaction, type RestTransaction } from './api';

interface Props {
  filter: TxFilter;
  onEdit: (tx: Transaction) => void;
  /** 父级递增的版本号：任一写操作后自增，触发本视图重新拉取 */
  version?: number;
  /** 本视图完成写操作后回调，通知父级刷新其它数据源 */
  onChanged?: () => void;
}

export function TransactionListView({ filter, onEdit, version = 0, onChanged }: Props) {
  const spaceId = useSpaceId();
  // spaceId === 0 表示"全部空间"，此时不拼 spaceId 让服务端返回全量
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;

  const { data: txRows, refetch: refetchTx } = useApi<RestTransaction[]>(
    `/api/transactions${spaceQ}`,
    [version],
  );
  const { data: categories } = useApi<Category[]>('/api/categories', [version]);
  const { data: accountsAll } = useApi<Account[]>(`/api/accounts${spaceQ}`, [version]);
  const { data: tags } = useApi<Tag[]>('/api/tags', [version]);
  const { data: merchants } = useApi<Merchant[]>('/api/merchants', [version]);

  // REST 行 → 前端类型（tagIds 是 JSON 文本，必须先还原成数组）
  const transactions = useMemo(() => (txRows ?? []).map(toTransaction), [txRows]);

  // 空间隔离：只展示当前空间下的流水 + 账户（转账/选账户时也要限定）
  const scopedTx = useMemo(
    () => filterBySpace(transactions, spaceId),
    [transactions, spaceId],
  );
  const accounts = useMemo(
    () => filterBySpace(accountsAll ?? [], spaceId),
    [accountsAll, spaceId],
  );

  const filtered = useMemo(() => applyFilter(scopedTx, filter), [scopedTx, filter]);

  const groups = useMemo(() => {
    const today = dayjs();
    const byKey = new Map<string, Transaction[]>();
    // 按"今天 / 昨天 / 具体日期"分组并保持倒序
    const keys: string[] = [];
    for (const t of filtered) {
      const k = groupKey(t.date, today);
      if (!byKey.has(k)) {
        byKey.set(k, []);
        keys.push(k);
      }
      byKey.get(k)!.push(t);
    }
    // 让"今天"始终在最上面
    const order = ['今天', '昨天'];
    keys.sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      if (ia !== -1 || ib !== -1) {
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      }
      // 其余按各组首笔日期倒序
      const ta = byKey.get(a)![0]?.date ?? 0;
      const tb = byKey.get(b)![0]?.date ?? 0;
      return tb - ta;
    });
    return keys.map((k) => ({ key: k, items: byKey.get(k)! }));
  }, [filtered]);

  const summary = useMemo(() => summarize(filtered), [filtered]);

  async function removeTx(tx: Transaction) {
    if (tx.id === undefined) return;
    if (!window.confirm(`删除「${tx.name}」？\n对应账户余额会自动回滚。`)) return;
    try {
      // 余额回滚由 core 的 DELETE 在事务内完成，前端不再自行算 delta
      await apiDelete(`/api/transactions/${tx.id}`);
      refetchTx();
      onChanged?.();
    } catch (e) {
      window.alert(`删除失败：${(e as Error).message}`);
    }
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="暂无流水"
        description={
          scopedTx.length === 0
            ? '创建一笔流水开始记账吧～'
            : '当前筛选条件下没有匹配的流水'
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* 合计卡 */}
      <div className="grid grid-cols-3 gap-4">
        <SumCell tone="income" label="收入" value={summary.income} />
        <SumCell tone="expense" label="支出" value={summary.expense} />
        <SumCell tone="neutral" label="数量" value={summary.count} isCount />
      </div>

      {/* 分组列表 */}
      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.key}>
            <h3 className="section-title mb-2 px-1">{g.key}</h3>
            <div className="card !p-0 divide-y divide-border dark:divide-border-dark">
              {g.items.map((t) => (
                <TxRow
                  key={t.id}
                  tx={t}
                  categories={categories ?? []}
                  accounts={accounts}
                  tags={tags ?? []}
                  merchants={merchants ?? []}
                  onEdit={() => onEdit(t)}
                  onDelete={() => removeTx(t)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SumCell({
  tone,
  label,
  value,
  isCount,
}: {
  tone: 'income' | 'expense' | 'neutral';
  label: string;
  value: number;
  isCount?: boolean;
}) {
  return (
    <div className="card !p-4">
      <div className="text-xs text-text-muted dark:text-text-muted-dark">{label}</div>
      <div
        className={clsx(
          'mt-1 text-xl font-medium tabular-nums',
          tone === 'income' && 'text-income',
          tone === 'expense' && 'text-expense',
          tone === 'neutral' && 'text-text dark:text-text-dark',
        )}
      >
        {isCount ? `${value} 笔` : formatMoney(value)}
      </div>
    </div>
  );
}

function TxRow({
  tx,
  categories,
  accounts,
  tags,
  merchants,
  onEdit,
  onDelete,
}: {
  tx: Transaction;
  categories: Category[];
  accounts: Account[];
  tags: Tag[];
  merchants: Merchant[];
  onEdit: () => void;
  onDelete: () => void;
}) {
  const cat = tx.categoryId ? categories.find((c) => c.id === tx.categoryId) : undefined;
  const acc = accounts.find((a) => a.id === tx.accountId);
  const toAcc = tx.toAccountId ? accounts.find((a) => a.id === tx.toAccountId) : undefined;
  const m = tx.merchantId ? merchants.find((x) => x.id === tx.merchantId) : undefined;

  return (
    <div className="group flex items-center gap-3 px-4 py-3 hover:bg-bg dark:hover:bg-bg-card-dark transition">
      {/* 分类图标 */}
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-none"
        style={{
          background: cat?.color ? `${cat.color}22` : undefined,
        }}
      >
        {typeIcon(tx, cat)}
      </div>

      {/* 主要信息 */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 text-sm font-medium truncate">
          {tx.name || (tx.type === 'transfer' ? '转账' : '不计收支')}
          {!tx.includeInAsset && (
            <span className="text-xs text-text-muted dark:text-text-muted-dark">（不计资产）</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-text-muted dark:text-text-muted-dark truncate">
          {cat ? (
            <span style={{ color: cat.color }}>{cat.name}</span>
          ) : tx.type === 'transfer' ? (
            <span>转账</span>
          ) : (
            <span>—</span>
          )}
          <span>·</span>
          <span>{dayjs(tx.date).format('HH:mm')}</span>
          <span>·</span>
          <span className="truncate">
            {acc?.name ?? '未知账户'}
            {tx.type === 'transfer' && toAcc && (
              <>
                {' '}→ {toAcc.name}
              </>
            )}
          </span>
          {m && (
            <>
              <span>·</span>
              <span className="flex items-center gap-0.5">
                <IconBuildingStore size={10} /> {m.name}
              </span>
            </>
          )}
        </div>
        {tx.tagIds && tx.tagIds.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 mt-1">
            <IconTag size={10} className="text-text-muted dark:text-text-muted-dark" />
            {tx.tagIds.map((id) => {
              const t = tags.find((x) => x.id === id);
              if (!t) return null;
              // 无自定义颜色时不要写死 #6b7280（暗底下过暗），改用 muted token
              const color = t.color ?? undefined;
              return (
                <span
                  key={id}
                  className={clsx(
                    'px-1.5 h-4 rounded text-[10px] inline-flex items-center',
                    // 无色时不要给底色（与卡片同色等于没画），只留 muted 文字
                    !color && 'text-text-muted dark:text-text-muted-dark',
                  )}
                  style={color ? { background: `${color}22`, color } : undefined}
                >
                  {t.name}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {/* 金额 */}
      <div
        className={clsx(
          'tabular-nums text-base font-medium flex-none',
          tx.type === 'income' && 'text-income',
          tx.type === 'expense' && 'text-expense',
          tx.type === 'transfer' && 'text-text-muted dark:text-text-muted-dark',
          tx.type === 'excluded' && 'text-text-muted dark:text-text-muted-dark',
        )}
      >
        {tx.type === 'income' ? '+' : tx.type === 'expense' ? '-' : ''}
        {formatMoney(tx.amount, false)}
      </div>

      {/* 操作 */}
      <div className="flex-none flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
        <button
          type="button"
          onClick={onEdit}
          className="p-1.5 rounded-lg hover:bg-bg dark:hover:bg-bg-card-dark text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark"
          title="编辑"
        >
          <IconPencil size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 rounded-lg hover:bg-expense-soft dark:hover:bg-expense-soft-dark hover:text-expense text-text-muted dark:text-text-muted-dark"
          title="删除"
        >
          <IconTrash size={14} />
        </button>
      </div>
    </div>
  );
}

function typeIcon(tx: Transaction, cat?: Category) {
  if (cat?.icon) return <span>{cat.icon}</span>;
  switch (tx.type) {
    case 'expense':
      return <IconWallet size={18} className="text-expense" />;
    case 'income':
      return <IconReceipt size={18} className="text-income" />;
    case 'transfer':
      return <IconArrowsLeftRight size={18} className="text-text-muted dark:text-text-muted-dark" />;
    case 'excluded':
      return <IconEyeOff size={18} className="text-text-muted dark:text-text-muted-dark" />;
  }
}

export default TransactionListView;
