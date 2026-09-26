/**
 * 新建 / 编辑 交易流水模态
 * ---------------------------------------------------------------
 * - 类型 Tab：支出 / 收入 / 转账 / 不计收支
 * - 名称、日期、金额、分类（按类型过滤 + optgroup 分组）、
 *   账户、转账时的"转入账户"、备注、标签多选、商户、计入资产
 * - 保存：在 Dexie 事务内回滚旧值 -> 应用新值 -> 写流水 / 更新账户余额
 */
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import dayjs from 'dayjs';
import { Modal, Input, Textarea, Select, Switch, Button, Badge } from '@/components/ui';
import {
  IconWallet,
  IconArrowsLeftRight,
  IconReceipt,
  IconEyeOff,
  IconCategory,
  IconBuildingStore,
} from '@tabler/icons-react';
import { db, type Account, type Category, type Tag, type Merchant, type Transaction, type TransactionType } from '@/db';
import { deltasOf } from './balance';
import { toDatetimeLocal } from './format';
import clsx from 'clsx';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 编辑时传入；新建时为 undefined */
  editing?: Transaction | null;
}

type TypeTab = TransactionType;

const TAB_META: Record<TypeTab, { label: string; icon: React.ReactNode }> = {
  expense: { label: '支出', icon: <IconWallet size={14} /> },
  income: { label: '收入', icon: <IconReceipt size={14} /> },
  transfer: { label: '转账', icon: <IconArrowsLeftRight size={14} /> },
  excluded: { label: '不计收支', icon: <IconEyeOff size={14} /> },
};

/* ---------------- helpers ---------------- */

function accountsOfType(
  accounts: Account[],
  type: TypeTab,
): Account[] {
  if (type === 'transfer') return accounts;
  if (type === 'income') {
    return accounts.filter((a) => a.type !== 'credit' && a.type !== 'debt');
  }
  // expense / excluded：可支出账户 = 除 credit 外的所有
  return accounts.filter((a) => a.type !== 'credit');
}

/* ---------------- component ---------------- */

export function TransactionFormModal({ open, onClose, editing }: Props) {
  const accounts = useLiveQuery(() => db.accounts.toArray(), [], [] as Account[]);
  const categories = useLiveQuery(() => db.categories.toArray(), [], [] as Category[]);
  const tags = useLiveQuery(() => db.tags.toArray(), [], [] as Tag[]);
  const merchants = useLiveQuery(() => db.merchants.toArray(), [], [] as Merchant[]);

  const [type, setType] = useState<TypeTab>('expense');
  const [name, setName] = useState('');
  const [dateStr, setDateStr] = useState(toDatetimeLocal(Date.now()));
  const [amount, setAmount] = useState<number | ''>('');
  const [categoryId, setCategoryId] = useState<number | undefined>();
  const [accountId, setAccountId] = useState<number | undefined>();
  const [toAccountId, setToAccountId] = useState<number | undefined>();
  const [remark, setRemark] = useState('');
  const [tagIds, setTagIds] = useState<number[]>([]);
  const [merchantId, setMerchantId] = useState<number | undefined>();
  const [includeInAsset, setIncludeInAsset] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 进入模态时初始化
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setType(editing.type);
      setName(editing.name);
      setDateStr(toDatetimeLocal(editing.date));
      setAmount(editing.amount);
      setCategoryId(editing.categoryId);
      setAccountId(editing.accountId);
      setToAccountId(editing.toAccountId);
      setRemark(editing.remark ?? '');
      setTagIds(editing.tagIds ?? []);
      setMerchantId(editing.merchantId);
      setIncludeInAsset(editing.includeInAsset);
    } else {
      setType('expense');
      setName('');
      setDateStr(toDatetimeLocal(Date.now()));
      setAmount('');
      setCategoryId(undefined);
      setAccountId(accounts[0]?.id);
      setToAccountId(undefined);
      setRemark('');
      setTagIds([]);
      setMerchantId(undefined);
      setIncludeInAsset(true);
    }
    setError(null);
  }, [open, editing, accounts]);

  // 切换 type 时清掉账户里不适用的
  useEffect(() => {
    if (!open) return;
    if (type === 'transfer') {
      if (toAccountId === undefined && accounts.length >= 2) {
        setToAccountId(accounts.find((a) => a.id !== accountId)?.id);
      }
    }
    if (type !== 'transfer' && toAccountId !== undefined) {
      setToAccountId(undefined);
    }
    if (type !== 'expense' && type !== 'income' && categoryId !== undefined) {
      setCategoryId(undefined);
    }
  }, [type, open, accounts, accountId, toAccountId, categoryId]);

  // 可选分类（按类型过滤 + 分组）
  const categoryOptions = useMemo(() => {
    if (type !== 'expense' && type !== 'income') return [];
    const filtered = categories.filter((c) => c.type === type);
    const groups = new Map<string, Category[]>();
    for (const c of filtered) {
      const arr = groups.get(c.group) ?? [];
      arr.push(c);
      groups.set(c.group, arr);
    }
    const opts: Array<{ label: string; value: string; disabled?: boolean }> = [];
    for (const [group, cats] of groups.entries()) {
      // 占位行：禁用作为分组头（用 disabled）
      opts.push({ label: `— ${group} —`, value: `_${group}`, disabled: true });
      for (const c of cats) {
        opts.push({
          label: `${c.icon ? `${c.icon} ` : ''}${c.name}`,
          value: String(c.id),
        });
      }
    }
    return opts;
  }, [categories, type]);

  const accountOptions = useMemo(() => {
    const list = accountsOfType(accounts, type);
    return list.map((a) => ({ label: a.name, value: String(a.id) }));
  }, [accounts, type]);

  const toAccountOptions = useMemo(() => {
    const list = accounts.filter((a) => a.id !== accountId);
    return list.map((a) => ({ label: a.name, value: String(a.id) }));
  }, [accounts, accountId]);

  const merchantOptions = useMemo(
    () => merchants.map((m) => ({ label: m.name, value: String(m.id) })),
    [merchants],
  );

  /* -------- validate & save -------- */

  function validate(): string | null {
    if (type !== 'excluded' && type !== 'transfer' && !name.trim()) {
      return '请填写名称';
    }
    if (!accountId) return '请选择账户';
    if (type === 'transfer' && !toAccountId) return '请选择转入账户';
    if (type === 'transfer' && accountId === toAccountId) return '转出与转入账户必须不同';
    if (type !== 'excluded' && (amount === '' || Number(amount) <= 0)) {
      return '金额必须大于 0';
    }
    if (type !== 'excluded' && type !== 'transfer' && !categoryId) {
      return '请选择分类';
    }
    return null;
  }

  async function save() {
    const msg = validate();
    if (msg) {
      setError(msg);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const finalAmount = amount === '' ? 0 : Math.abs(Number(amount));
      const dateTs = dayjs(dateStr).valueOf();
      const txBase: Transaction = {
        type,
        name: name.trim() || (type === 'transfer' ? '转账' : '不计收支'),
        amount: finalAmount,
        date: dateTs,
        accountId: accountId as number,
        toAccountId: type === 'transfer' ? toAccountId : undefined,
        categoryId: type === 'expense' || type === 'income' ? categoryId : undefined,
        remark: remark.trim() || undefined,
        tagIds: tagIds.length > 0 ? tagIds : undefined,
        merchantId,
        includeInAsset,
        createdAt: editing?.createdAt ?? Date.now(),
      };

      await db.transaction('rw', db.transactions, db.accounts, async () => {
        // 编辑时：先回滚老的影响
        if (editing?.id !== undefined) {
          const oldTx = await db.transactions.get(editing.id);
          if (oldTx) {
            for (const d of deltasOf(oldTx)) {
              const acc = await db.accounts.get(d.accountId);
              if (acc) {
                acc.balance = Number((acc.balance - d.delta).toFixed(2));
                acc.updatedAt = Date.now();
                await db.accounts.put(acc);
              }
            }
          }
        }
        // 应用新影响
        for (const d of deltasOf(txBase)) {
          const acc = await db.accounts.get(d.accountId);
          if (acc) {
            acc.balance = Number((acc.balance + d.delta).toFixed(2));
            acc.updatedAt = Date.now();
            await db.accounts.put(acc);
          }
        }
        // 写流水
        if (editing?.id !== undefined) {
          await db.transactions.put({ ...txBase, id: editing.id });
        } else {
          await db.transactions.add(txBase);
        }
      });

      onClose();
    } catch (e) {
      setError((e as Error).message ?? '保存失败');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? '编辑流水' : '新建流水'}
      width={520}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving ? '保存中…' : '确认'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {/* 类型 Tab */}
        <div className="flex items-center gap-1 p-1 bg-bg dark:bg-bg-card-dark rounded-xl w-fit">
          {(Object.keys(TAB_META) as TypeTab[]).map((k) => {
            const meta = TAB_META[k];
            const active = type === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setType(k)}
                className={clsx(
                  'flex items-center gap-1.5 h-8 px-3 text-sm rounded-lg transition',
                  active
                    ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark shadow'
                    : 'text-text-muted hover:text-text dark:hover:text-text-dark',
                )}
              >
                {meta.icon}
                <span>{meta.label}</span>
              </button>
            );
          })}
        </div>

        {error && (
          <div className="text-sm text-expense bg-expense-soft dark:bg-expense-soft-dark rounded-xl px-3 py-2">
            {error}
          </div>
        )}

        {/* 名称 + 日期 */}
        {type !== 'transfer' && (
          <Field label={`${type === 'excluded' ? '说明' : '名称'}${type !== 'excluded' ? ' *' : ''}`}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={type === 'excluded' ? '可选备注' : '购物，餐饮等支出'}
              block
            />
          </Field>
        )}
        <Field label="交易日期 *">
          <Input
            type="datetime-local"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
            block
          />
        </Field>

        {/* 金额 */}
        {type !== 'excluded' && (
          <Field label="金额 *">
            <Input
              type="number"
              step="0.01"
              min="0"
              prefix={<span className="text-sm">¥</span>}
              value={amount === '' ? '' : String(amount)}
              onChange={(e) => setAmount(e.target.value === '' ? '' : Number(e.target.value))}
              placeholder="0.00"
              block
            />
          </Field>
        )}

        {/* 分类 */}
        {(type === 'expense' || type === 'income') && (
          <Field label="分类 *">
            <Select
              placeholder="请选择分类"
              value={categoryId === undefined ? '' : String(categoryId)}
              onChange={(e) =>
                setCategoryId(e.target.value === '' ? undefined : Number(e.target.value))
              }
              options={categoryOptions}
              block
            />
          </Field>
        )}

        {/* 账户 */}
        <Field label={type === 'transfer' ? '转出账户 *' : '账户 *'}>
          <Select
            placeholder="请选择账户"
            value={accountId === undefined ? '' : String(accountId)}
            onChange={(e) => setAccountId(e.target.value === '' ? undefined : Number(e.target.value))}
            options={accountOptions}
            block
          />
        </Field>

        {/* 转入账户 */}
        {type === 'transfer' && (
          <Field label="转入账户 *">
            <Select
              placeholder="请选择账户"
              value={toAccountId === undefined ? '' : String(toAccountId)}
              onChange={(e) =>
                setToAccountId(e.target.value === '' ? undefined : Number(e.target.value))
              }
              options={toAccountOptions}
              block
            />
          </Field>
        )}

        {/* 备注 */}
        <Field label="备注">
          <div className="relative">
            <Textarea
              value={remark}
              onChange={(e) => setRemark(e.target.value.slice(0, 200))}
              maxLength={200}
              placeholder="添加备注（最多 200 字）"
              className="pb-6"
            />
            <div className="absolute right-3 bottom-2 text-xs text-text-muted pointer-events-none">
              {remark.length}/200
            </div>
          </div>
        </Field>

        {/* 标签多选 */}
        {tags.length > 0 && (
          <Field label="标签">
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => {
                const active = tagIds.includes(t.id as number);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() =>
                      setTagIds((prev) =>
                        active
                          ? prev.filter((x) => x !== t.id)
                          : [...prev, t.id as number],
                      )
                    }
                    className="rounded-lg transition border h-7 px-2.5 text-xs"
                    style={{
                      borderColor: active ? t.color : 'transparent',
                      background: active
                        ? `${t.color}22`
                        : 'rgb(229 231 235 / 1)',
                    }}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}

        {/* 商户 */}
        {merchants.length > 0 && (
          <Field label="商户">
            <div className="flex items-center gap-2">
              <IconBuildingStore size={16} className="text-text-muted" />
              <Select
                placeholder="选择商户（可选）"
                value={merchantId === undefined ? '' : String(merchantId)}
                onChange={(e) =>
                  setMerchantId(e.target.value === '' ? undefined : Number(e.target.value))
                }
                options={merchantOptions}
                block
              />
            </div>
          </Field>
        )}

        {/* 计入资产 */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm flex items-center gap-1.5">
              <IconCategory size={14} className="text-text-muted" />
              计入资产
            </div>
            <div className="text-xs text-text-muted mt-0.5">
              关闭后将不计入净资产统计
            </div>
          </div>
          <Switch checked={includeInAsset} onChange={setIncludeInAsset} />
        </div>

        {/* 当前选择预览 */}
        {selectedAccountBadge(accountId, accounts)}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-text-muted mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function selectedAccountBadge(id: number | undefined, accounts: Account[]) {
  if (!id) return null;
  const a = accounts.find((x) => x.id === id);
  if (!a) return null;
  return (
    <div className="flex items-center gap-2 text-xs text-text-muted">
      <Badge tone="neutral">当前账户余额</Badge>
      <span className="tabular-nums">
        ¥ {a.balance.toLocaleString('zh-CN', { minimumFractionDigits: 2 })}
      </span>
    </div>
  );
}

export default TransactionFormModal;
