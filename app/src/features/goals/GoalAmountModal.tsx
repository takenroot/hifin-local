/**
 * 「存入 / 取出」快捷更新模态
 *
 * - 调整 currentAmount；可选联动账户余额（存入：账户余额 -= amount；
 *   取出：账户余额 += amount，相当于把"已存的钱"释放到可用资金）。
 * - 真实写库：db.transaction('rw', db.goals, db.accounts, ...) 保证一致。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Switch } from '@/components/ui';
import { db, type Account, type Goal } from '@/db';
import { formatMoney, parseAmount } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  goal: Goal | null;
  mode: 'deposit' | 'withdraw';
  /** 已关联账户（用于联动余额） */
  account?: Account;
}

const AMOUNT_LIMIT = 12;

export function GoalAmountModal({ open, onClose, goal, mode, account }: Props) {
  const [amount, setAmount] = useState('');
  const [adjustAccount, setAdjustAccount] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 重置
  useEffect(() => {
    if (open) {
      setAmount('');
      setAdjustAccount(true);
      setError(null);
    }
  }, [open, goal?.id, mode]);

  const title = mode === 'deposit' ? '存入' : '取出';
  const accent = mode === 'deposit' ? 'text-income' : 'text-expense';

  const numAmount = useMemo(() => parseAmount(amount), [amount]);
  const tooLong = amount.length > AMOUNT_LIMIT;
  const overflow =
    mode === 'withdraw' && goal ? numAmount > goal.currentAmount : false;
  const invalid = !amount || numAmount <= 0 || tooLong || overflow;

  if (!goal) {
    // keep modal not crashing
    return <Modal open={false} onClose={onClose} title="" />;
  }

  async function handleConfirm() {
    if (!goal?.id) return;
    if (invalid) {
      setError(
        overflow
          ? '取出金额超过当前已存金额'
          : !amount || numAmount <= 0
            ? '请输入有效金额'
            : '金额过长',
      );
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const delta = mode === 'deposit' ? numAmount : -numAmount;
      await db.transaction('rw', db.goals, db.accounts, async () => {
        const fresh = await db.goals.get(goal.id!);
        if (!fresh) return;
        const newCurrent = Math.max(
          0,
          Math.min(
            fresh.targetAmount || Number.MAX_SAFE_INTEGER,
            fresh.currentAmount + delta,
          ),
        );
        await db.goals.update(goal.id!, { currentAmount: newCurrent });
        // 联动账户余额
        if (adjustAccount && account?.id != null) {
          const acc = await db.accounts.get(account.id);
          if (acc) {
            // 存款到目标视为资金从可用账户挪走（账户余额 -= amount）
            // 取出视为资金回到账户（账户余额 += amount）
            const accDelta = mode === 'deposit' ? -numAmount : numAmount;
            acc.balance = Number((acc.balance + accDelta).toFixed(2));
            acc.updatedAt = Date.now();
            await db.accounts.put(acc);
          }
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
      title={`${title} · ${goal.name}`}
      width={420}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            取消
          </Button>
          <Button
            variant="primary"
            disabled={invalid || saving}
            onClick={handleConfirm}
          >
            {saving ? '保存中…' : '确认'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-xl bg-bg dark:bg-bg-card-dark p-4 space-y-1">
          <div className="text-xs text-text-muted">
            已{title === '存入' ? '存' : '还'}
            <span className={`ml-1 ${accent} tabular-nums`}>
              {formatMoney(goal.currentAmount, false)}
            </span>
            <span className="ml-1">/ {formatMoney(goal.targetAmount, false)}</span>
          </div>
          <div className="text-base font-medium">
            {mode === 'deposit' ? '本次存入' : '本次取出'}
            <span className={`ml-2 tabular-nums ${accent}`}>
              {formatMoney(numAmount, false)}
            </span>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm">
              金额 <span className="text-expense">*</span>
            </label>
            <span
              className={`text-xs tabular-nums ${
                tooLong ? 'text-expense' : 'text-text-muted'
              }`}
            >
              {amount.length}/{AMOUNT_LIMIT}
            </span>
          </div>
          <Input
            prefix={<span>¥</span>}
            value={amount}
            placeholder="0.00"
            autoFocus
            maxLength={AMOUNT_LIMIT}
            invalid={tooLong || overflow}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        {account ? (
          <div className="flex items-center justify-between rounded-xl border border-border dark:border-border-dark p-3">
            <div>
              <div className="text-sm">联动「{account.name}」账户余额</div>
              <div className="text-xs text-text-muted mt-0.5">
                {mode === 'deposit'
                  ? '存款时账户余额会同步减少'
                  : '取出时账户余额会同步增加'}
              </div>
            </div>
            <Switch checked={adjustAccount} onChange={setAdjustAccount} />
          </div>
        ) : (
          <div className="text-xs text-text-muted">
            未关联账户，本操作不会影响任何账户余额。
          </div>
        )}

        {error && (
          <div className="text-sm text-expense bg-expense-soft dark:bg-expense-soft-dark rounded-xl px-3 py-2">
            {error}
          </div>
        )}
      </div>
    </Modal>
  );
}

export default GoalAmountModal;
