/**
 * 顶部筛选：类型 / 分类 / 账户 / 日期范围
 */
import { useMemo } from 'react';
import dayjs from 'dayjs';
import { useLiveQuery } from 'dexie-react-hooks';
import { IconFilter, IconX } from '@tabler/icons-react';
import { db, type Category, type Account, type TransactionType } from '@/db';
import { Select } from '@/components/ui';
import { Input } from '@/components/ui';
import type { TxFilter } from './balance';

interface Props {
  filter: TxFilter;
  onChange: (next: TxFilter) => void;
}

const TYPE_OPTS: Array<{ label: string; value: string }> = [
  { label: '全部', value: '' },
  { label: '支出', value: 'expense' },
  { label: '收入', value: 'income' },
  { label: '转账', value: 'transfer' },
  { label: '不计收支', value: 'excluded' },
];

export function TransactionFilterBar({ filter, onChange }: Props) {
  const categories = useLiveQuery(() => db.categories.toArray(), [], [] as Category[]);
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], [] as Account[]);

  const categoryOptions = useMemo(() => {
    const groups = new Map<string, Category[]>();
    for (const c of categories) {
      const arr = groups.get(c.group) ?? [];
      arr.push(c);
      groups.set(c.group, arr);
    }
    const opts: Array<{ label: string; value: string; disabled?: boolean }> = [
      { label: '全部分类', value: '' },
    ];
    for (const [group, cats] of groups.entries()) {
      opts.push({ label: `— ${group} —`, value: `_${group}`, disabled: true });
      for (const c of cats) {
        opts.push({ label: `${c.icon ?? ''} ${c.name}`, value: String(c.id) });
      }
    }
    return opts;
  }, [categories]);

  const accountOptions = useMemo(
    () => [
      { label: '全部账户', value: '' },
      ...accounts.map((a) => ({ label: a.name, value: String(a.id) })),
    ],
    [accounts],
  );

  const fromStr = filter.from ? dayjs(filter.from).format('YYYY-MM-DD') : '';
  const toStr = filter.to ? dayjs(filter.to).format('YYYY-MM-DD') : '';

  const activeType = filter.types && filter.types.length === 1 ? filter.types[0] : '';
  const isActive =
    !!activeType ||
    !!filter.categoryId ||
    !!filter.accountId ||
    !!filter.from ||
    !!filter.to;

  function setType(v: string) {
    if (!v) {
      onChange({ ...filter, types: undefined });
    } else {
      onChange({ ...filter, types: [v as TransactionType] });
    }
  }

  function reset() {
    onChange({});
  }

  return (
    <div className="card !p-3 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-2 text-text-muted text-sm flex-none">
        <IconFilter size={14} />
        <span>筛选</span>
      </div>

      <div className="w-32">
        <Select
          options={TYPE_OPTS}
          value={activeType}
          onChange={(e) => setType(e.target.value)}
          block
        />
      </div>

      <div className="w-40">
        <Select
          options={categoryOptions}
          value={filter.categoryId ? String(filter.categoryId) : ''}
          onChange={(e) =>
            onChange({
              ...filter,
              categoryId: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          block
        />
      </div>

      <div className="w-36">
        <Select
          options={accountOptions}
          value={filter.accountId ? String(filter.accountId) : ''}
          onChange={(e) =>
            onChange({
              ...filter,
              accountId: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
          block
        />
      </div>

      <Input
        type="date"
        value={fromStr}
        onChange={(e) =>
          onChange({
            ...filter,
            from: e.target.value ? dayjs(e.target.value).startOf('day').valueOf() : undefined,
          })
        }
        className="!w-36"
      />
      <span className="text-text-muted">~</span>
      <Input
        type="date"
        value={toStr}
        onChange={(e) =>
          onChange({
            ...filter,
            to: e.target.value ? dayjs(e.target.value).endOf('day').valueOf() : undefined,
          })
        }
        className="!w-36"
      />

      {isActive && (
        <button
          type="button"
          onClick={reset}
          className="flex items-center gap-1 text-xs text-text-muted hover:text-text dark:hover:text-text-dark px-2 h-8 rounded-lg hover:bg-bg dark:hover:bg-bg-card-dark"
        >
          <IconX size={12} /> 清除
        </button>
      )}
    </div>
  );
}

export default TransactionFilterBar;
