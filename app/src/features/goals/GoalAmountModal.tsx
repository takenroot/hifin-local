/**
 * 「存入 / 取出」快捷更新模态
 *
 * - 调整 currentAmount。
 * - 账户余额联动改由服务端完成：PUT /api/goals/:id 会在事务内先撤销旧
 *   currentAmount 对关联账户的贡献，再按新值重新计入（saving 记 +，repayment 记 -）。
 *   因此"是否联动账户"不再是前端可选项——只要目标关联了账户就会联动。
 */
import { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal } from '@/components/ui';
import { apiFetch } from '@/hooks/useApi';
import { type Account, type Goal } from '@/db';
import { formatMoney, parseAmount } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  goal: Goal | null;
  mode: 'deposit' | 'withdraw';
  /** 已关联账户（仅用于展示说明） */
  account?: Account;
  /** 保存成功后通知父级刷新列表 */
  onChanged?: () => void;
}

const AMOUNT_LIMIT = 12;

export function GoalAmountModal({ open, onClose, goal, mode, account, onChanged }: Props) {
  const [amount, setAmount] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 重置
  useEffect(() => {
    if (open) {
      setAmount('');
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
      const newCurrent = Math.max(
        0,
        Math.min(goal.targetAmount || Number.MAX_SAFE_INTEGER, goal.currentAmount + delta),
      );
      // 只提交新的 currentAmount；余额联动由 core 在同一事务内完成
      await apiFetch(`/api/goals/${goal.id}`, 'PUT', { currentAmount: newCurrent });
      onChanged?.();
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
          <div className="rounded-xl border border-border dark:border-border-dark p-3 text-xs text-text-muted">
            「{account.name}」账户余额会由服务端随本次{title}同步调整。
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
