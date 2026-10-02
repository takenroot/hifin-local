/**
 * 预算创建 / 编辑模态
 *
 * 字段：名称、关联分类（可空 = 总预算）、金额、周期（月度 / 年度）
 */
import { useEffect, useMemo, useState } from 'react';
import { IconCheck } from '@tabler/icons-react';
import { Button, Input, Modal, Select } from '@/components/ui';
import { type Budget, type Category, type BudgetPeriod, useSpaceId } from '@/db';
import { useApi, apiFetch } from '@/hooks/useApi';
import { parseAmount } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 编辑时传入 */
  budget?: Budget;
  /** 父级写操作版本号，驱动分类下拉重新拉取 */
  version?: number;
  /** 保存成功后通知父级刷新列表 */
  onSaved?: () => void;
}

interface FormState {
  name: string;
  categoryId: number | undefined; // undefined 表示"总预算"
  amount: string;
  period: BudgetPeriod;
}

const NAME_LIMIT = 30;
const AMOUNT_LIMIT = 12;

const DEFAULT_FORM: FormState = {
  name: '',
  categoryId: undefined,
  amount: '',
  period: 'monthly',
};

function formFromBudget(b: Budget): FormState {
  return {
    name: b.name,
    categoryId: b.categoryId,
    amount: b.amount === 0 ? '' : String(b.amount),
    period: b.period,
  };
}

export function BudgetFormModal({ open, onClose, budget, version = 0, onSaved }: Props) {
  const isEdit = !!budget;
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spaceId = useSpaceId();

  const { data: categories } = useApi<Category[]>('/api/categories', [version]);

  useEffect(() => {
    if (!open) return;
    setForm(budget ? formFromBudget(budget) : DEFAULT_FORM);
    setSubmitted(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, budget?.id]);

  const trimmedName = form.name.trim();
  const nameInvalid = submitted && trimmedName.length === 0;
  const nameTooLong = form.name.length > NAME_LIMIT;
  const amountTooLong = form.amount.length > AMOUNT_LIMIT;
  const amountInvalid = submitted && parseAmount(form.amount) <= 0;

  const canConfirm =
    trimmedName.length > 0 &&
    !nameTooLong &&
    !amountTooLong &&
    !amountInvalid;

  const title = isEdit ? '编辑预算' : '新建预算';

  const categoryOptions = useMemo(() => {
    const list = (categories ?? [])
      .filter((c) => c.type === 'expense')
      .sort((a, b) => {
        if (a.group !== b.group) return a.group.localeCompare(b.group, 'zh-CN');
        return a.name.localeCompare(b.name, 'zh-CN');
      });
    return [
      { value: '', label: '总预算（覆盖全部支出）' },
      ...list.map((c) => ({
        value: String(c.id),
        label: `${c.group} · ${c.name}`,
      })),
    ];
  }, [categories]);

  const periodOptions = [
    { value: 'monthly', label: '月度' },
    { value: 'yearly', label: '年度' },
  ];

  async function handleConfirm() {
    setSubmitted(true);
    if (!canConfirm) return;
    setError(null);
    // categoryId 用 null 表达"总预算"（服务端 parseCategoryId 接受 null）
    const payload: Record<string, unknown> = {
      name: trimmedName,
      categoryId: form.categoryId ?? null,
      amount: parseAmount(form.amount),
      period: form.period,
      spaceId: budget?.spaceId ?? spaceId,
    };
    try {
      if (budget?.id != null) {
        await apiFetch(`/api/budgets/${budget.id}`, 'PUT', payload);
      } else {
        await apiFetch('/api/budgets', 'POST', payload);
      }
      onSaved?.();
      onClose();
    } catch (e) {
      setError((e as Error).message ?? '保存失败');
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      width={480}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button
            variant="primary"
            icon={<IconCheck size={16} />}
            disabled={!canConfirm}
            onClick={handleConfirm}
          >
            确认
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/* 名称 */}
        <Field label="预算名称" required>
          <Input
            placeholder="例如：日常餐饮 / 全月总支出"
            value={form.name}
            maxLength={NAME_LIMIT}
            invalid={nameInvalid || nameTooLong}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <FieldHint
            hint={`${form.name.length}/${NAME_LIMIT}`}
            error={
              nameTooLong
                ? '名称过长'
                : nameInvalid
                  ? '名称不能为空'
                  : ''
            }
          />
        </Field>

        {/* 关联分类 */}
        <Field label="关联分类" hint="不选则为覆盖全部支出的总预算">
          <Select
            options={categoryOptions}
            value={form.categoryId === undefined ? '' : String(form.categoryId)}
            onChange={(e) =>
              setForm({
                ...form,
                categoryId:
                  e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
          />
        </Field>

        {/* 金额 + 周期 */}
        <div className="grid grid-cols-2 gap-3">
          <Field label="预算金额" required>
            <Input
              prefix={<span>¥</span>}
              placeholder="0.00"
              value={form.amount}
              maxLength={AMOUNT_LIMIT}
              invalid={amountTooLong || amountInvalid}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
            />
            <FieldHint
              hint={`${form.amount.length}/${AMOUNT_LIMIT}`}
              error={
                amountInvalid
                  ? '金额必须大于 0'
                  : amountTooLong
                    ? '过长'
                    : ''
              }
            />
          </Field>
          <Field label="周期" required>
            <Select
              options={periodOptions}
              value={form.period}
              onChange={(e) =>
                setForm({ ...form, period: e.target.value as BudgetPeriod })
              }
            />
          </Field>
        </div>

        {error && (
          <div className="text-sm text-expense bg-expense-soft dark:bg-expense-soft-dark rounded-xl px-3 py-2">
            {error}
          </div>
        )}

        {submitted && (nameInvalid || amountInvalid) && (
          <div className="text-xs text-expense">
            {nameInvalid && '请填写预算名称；'}
            {amountInvalid && '金额必须大于 0；'}
          </div>
        )}
      </div>
    </Modal>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        {/* Modal 通过 portal 挂到 body，脱离 AppLayout 的 text-text 根色。
            未显式声明颜色的文字在暗黑模式下会退回浏览器默认纯黑，压在深色卡片上不可见，
            于是只剩下带 text-expense 的红色星号可见——必须显式给 label 上色。 */}
        <label className="text-sm text-text dark:text-text-dark">
          {label}
          {required && <span className="text-expense ml-0.5">*</span>}
        </label>
        {hint && <span className="text-xs text-text-muted dark:text-text-muted-dark">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function FieldHint({ hint, error }: { hint: string; error: string }) {
  return (
    <div className="mt-1 flex justify-between text-xs">
      <span className={error ? 'text-expense' : 'text-transparent'}>
        {error || '·'}
      </span>
      <span className="text-text-muted dark:text-text-muted-dark tabular-nums">{hint}</span>
    </div>
  );
}

export default BudgetFormModal;