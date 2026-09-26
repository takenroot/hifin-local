/**
 * 交易列表视图（按日分组 + 筛选 + 行内编辑 / 删除）
 */
import { useMemo } from 'react';
import dayjs from 'dayjs';
import { useLiveQuery } from 'dexie-react-hooks';
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
  db,
  type Transaction,
  type Category,
  type Account,
  type Tag,
  type Merchant,
} from '@/db';
import { EmptyState } from '@/components/ui';
import { applyFilter, summarize, type TxFilter } from './balance';
import { formatMoney, groupKey } from './format';

interface Props {
  filter: TxFilter;
  onEdit: (tx: Transaction) => void;
  onRefresh?: () => void;
}

export function TransactionListView({ filter, onEdit }: Props) {
  const transactions = useLiveQuery(
    () => db.transactions.orderBy('date').reverse().toArray(),
    [],
    [] as Transaction[],
  );
  const categories = useLiveQuery(() => db.categories.toArray(), [], [] as Category[]);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], [] as Account[]);
  const tags = useLiveQuery(() => db.tags.toArray(), [], [] as Tag[]);
  const merchants = useLiveQuery(() => db.merchants.toArray(), [], [] as Merchant[]);

  const filtered = useMemo(() => applyFilter(transactions, filter), [transactions, filter]);

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
    await db.transaction('rw', db.transactions, db.accounts, async () => {
      // 回滚：拿所有 deltas 抵消
      const affected: Array<{ accountId: number; delta: number }> = [];
      if (tx.type !== 'excluded') {
        if (tx.type === 'expense') affected.push({ accountId: tx.accountId, delta: -tx.amount });
        else if (tx.type === 'income') affected.push({ accountId: tx.accountId, delta: tx.amount });
        else if (tx.type === 'transfer' && tx.toAccountId && tx.toAccountId !== tx.accountId) {
          affected.push({ accountId: tx.accountId, delta: -tx.amount });
          affected.push({ accountId: tx.toAccountId, delta: tx.amount });
        }
      }
      for (const d of affected) {
        const acc = await db.accounts.get(d.accountId);
        if (acc) {
          acc.balance = Number((acc.balance - d.delta).toFixed(2));
          acc.updatedAt = Date.now();
          await db.accounts.put(acc);
        }
      }
      await db.transactions.delete(tx.id!);
    });
  }

  if (filtered.length === 0) {
    return (
      <EmptyState
        title="暂无流水"
        description={
          transactions.length === 0
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
                  categories={categories}
                  accounts={accounts}
                  tags={tags}
                  merchants={merchants}
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
      <div className="text-xs text-text-muted">{label}</div>
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
            <span className="text-xs text-text-muted">（不计资产）</span>
          )}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 text-xs text-text-muted truncate">
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
            <IconTag size={10} className="text-text-muted" />
            {tx.tagIds.map((id) => {
              const t = tags.find((x) => x.id === id);
              if (!t) return null;
              return (
                <span
                  key={id}
                  className="px-1.5 h-4 rounded text-[10px] inline-flex items-center"
                  style={{ background: `${t.color ?? '#6b7280'}22`, color: t.color ?? '#6b7280' }}
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
          tx.type === 'transfer' && 'text-text-muted',
          tx.type === 'excluded' && 'text-text-muted',
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
          className="p-1.5 rounded-lg hover:bg-bg dark:hover:bg-bg-card-dark text-text-muted hover:text-text dark:hover:text-text-dark"
          title="编辑"
        >
          <IconPencil size={14} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="p-1.5 rounded-lg hover:bg-expense-soft hover:text-expense text-text-muted"
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
      return <IconArrowsLeftRight size={18} className="text-text-muted" />;
    case 'excluded':
      return <IconEyeOff size={18} className="text-text-muted" />;
  }
}

export default TransactionListView;
