/**
 * 目标创建 / 编辑模态（两步）
 *
 * - 第一步：选择 kind（存款 / 还款），并从 subtype 候选网格里挑一项作为图标 / 颜色 / 名称预设
 * - 第二步：填写完整表单（名称、目标金额、当前已存金额、截止日期、关联账户、图标 / 颜色）
 * - 编辑模式直接进入第二步
 */
import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconChevronLeft,
  IconCheck,
  IconChevronRight,
  IconTrendingUp,
  IconTrendingDown,
  IconCircleCheckFilled,
} from '@tabler/icons-react';
import {
  Button,
  Input,
  Modal,
  Select,
} from '@/components/ui';
import { db, type Account, type Goal, type GoalKind, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import {
  COLOR_CHOICES,
  REPAYMENT_SUBTYPES,
  SAVING_SUBTYPES,
  kindLabel,
  lookupMeta,
  type GoalSubtypeOption,
} from './metadata';
import { fromDateInput, parseAmount, toDateInput } from './format';

interface Props {
  open: boolean;
  onClose: () => void;
  /** 编辑时传入 */
  goal?: Goal;
}

type Step = 'pick-kind' | 'pick-subtype' | 'fill-form';

interface FormState {
  kind: GoalKind;
  subtype: string;
  icon: string;
  color: string;
  name: string;
  targetAmount: string;
  currentAmount: string;
  deadline: string; // yyyy-MM-dd
  accountId: number | undefined;
}

const NAME_LIMIT = 30;
const TARGET_LIMIT = 12;
const CURRENT_LIMIT = 12;

const DEFAULT_FORM: FormState = {
  kind: 'saving',
  subtype: '其他',
  icon: '💰',
  color: '#10b981',
  name: '',
  targetAmount: '',
  currentAmount: '',
  deadline: '',
  accountId: undefined,
};

function formFromGoal(g: Goal): FormState {
  const meta = lookupMeta(g.kind, g.subtype);
  return {
    kind: g.kind,
    subtype: g.subtype ?? '其他',
    icon: g.icon ?? meta.icon,
    color: g.color ?? meta.color,
    name: g.name,
    targetAmount: g.targetAmount === 0 ? '' : String(g.targetAmount),
    currentAmount: g.currentAmount === 0 ? '' : String(g.currentAmount),
    deadline: toDateInput(g.deadline),
    accountId: g.accountId,
  };
}

export function GoalFormModal({ open, onClose, goal }: Props) {
  const isEdit = !!goal;
  const [step, setStep] = useState<Step>(isEdit ? 'fill-form' : 'pick-kind');
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitted, setSubmitted] = useState(false);

  const accountsAll = useLiveQuery(
    () => db.accounts.orderBy('name').toArray(),
    [],
  );
  const spaceId = useSpaceId();
  const accounts = useMemo(
    () => filterBySpace(accountsAll ?? [], spaceId),
    [accountsAll, spaceId],
  );

  useEffect(() => {
    if (!open) return;
    setStep(isEdit ? 'fill-form' : 'pick-kind');
    setForm(goal ? formFromGoal(goal) : DEFAULT_FORM);
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, goal?.id]);

  const trimmedName = form.name.trim();
  const nameInvalid = submitted && trimmedName.length === 0;
  const nameTooLong = form.name.length > NAME_LIMIT;
  const targetTooLong = form.targetAmount.length > TARGET_LIMIT;
  const currentTooLong = form.currentAmount.length > CURRENT_LIMIT;
  const targetInvalid = submitted && parseAmount(form.targetAmount) <= 0;
  const currentInvalid =
    submitted && parseAmount(form.currentAmount) < 0;

  const canFillConfirm =
    trimmedName.length > 0 &&
    !nameTooLong &&
    !targetTooLong &&
    !currentTooLong &&
    !targetInvalid &&
    !currentInvalid;

  const title = isEdit ? '编辑目标' : '新建目标';

  function handleClose() {
    onClose();
  }

  async function handleConfirm() {
    setSubmitted(true);
    if (!canFillConfirm) return;
    const deadlineTs = fromDateInput(form.deadline);
    const now = Date.now();
    const payload: Omit<Goal, 'id'> = {
      kind: form.kind,
      subtype: form.subtype,
      name: trimmedName,
      targetAmount: parseAmount(form.targetAmount),
      currentAmount: parseAmount(form.currentAmount),
      deadline: deadlineTs,
      accountId: form.accountId,
      icon: form.icon,
      color: form.color,
      spaceId: goal?.spaceId ?? spaceId,
      createdAt: goal?.createdAt ?? now,
    };
    if (goal?.id != null) {
      await db.goals.update(goal.id, payload);
    } else {
      await db.goals.add(payload);
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      width={520}
      footer={
        <>
          {step === 'pick-subtype' && !isEdit && (
            <Button
              variant="ghost"
              icon={<IconChevronLeft size={16} />}
              onClick={() => setStep('pick-kind')}
            >
              上一步
            </Button>
          )}
          {step === 'fill-form' && !isEdit && (
            <Button
              variant="ghost"
              icon={<IconChevronLeft size={16} />}
              onClick={() => setStep('pick-subtype')}
            >
              上一步
            </Button>
          )}
          <div className="flex-1" />
          {step === 'pick-kind' && !isEdit && (
            <Button
              variant="primary"
              icon={<IconChevronRight size={16} />}
              onClick={() => setStep('pick-subtype')}
            >
              下一步
            </Button>
          )}
          {step === 'pick-subtype' && !isEdit && (
            <Button
              variant="primary"
              icon={<IconChevronRight size={16} />}
              onClick={() => setStep('fill-form')}
            >
              下一步
            </Button>
          )}
          {step === 'fill-form' && (
            <Button
              variant="primary"
              icon={<IconCheck size={16} />}
              disabled={!canFillConfirm}
              onClick={handleConfirm}
            >
              确认
            </Button>
          )}
        </>
      }
    >
      {step === 'pick-kind' && !isEdit ? (
        <KindPicker
          picked={form.kind}
          onPick={(k) => {
            const list = k === 'saving' ? SAVING_SUBTYPES : REPAYMENT_SUBTYPES;
            setForm({ ...form, kind: k, subtype: list[0].value });
          }}
        />
      ) : step === 'pick-subtype' && !isEdit ? (
        <SubtypePicker
          kind={form.kind}
          picked={form.subtype}
          onPick={(opt) =>
            setForm({
              ...form,
              subtype: opt.value,
              icon: opt.icon,
              color: opt.color,
              name: form.name.trim() === '' ? opt.label : form.name,
            })
          }
        />
      ) : (
        <FormStep
          form={form}
          setForm={setForm}
          accounts={accounts ?? []}
          submitted={submitted}
          nameInvalid={nameInvalid}
          nameTooLong={nameTooLong}
          targetTooLong={targetTooLong}
          currentTooLong={currentTooLong}
          targetInvalid={!!targetInvalid}
          currentInvalid={!!currentInvalid}
        />
      )}
    </Modal>
  );
}

/* ──────────────────── 第一步：选择 kind ──────────────────── */

function KindPicker({
  picked,
  onPick,
}: {
  picked: GoalKind;
  onPick: (k: GoalKind) => void;
}) {
  return (
    <div className="space-y-4">
      <div className="text-sm text-text-muted">第一步 · 选择目标类型</div>
      <div className="grid grid-cols-2 gap-3">
        {(
          [
            {
              kind: 'saving' as const,
              icon: <IconTrendingUp size={20} />,
              desc: '例如买房、应急、旅行等储蓄计划',
            },
            {
              kind: 'repayment' as const,
              icon: <IconTrendingDown size={20} />,
              desc: '例如信用卡、车贷、房贷等还款计划',
            },
          ]
        ).map((it) => {
          const active = picked === it.kind;
          return (
            <button
              key={it.kind}
              type="button"
              onClick={() => onPick(it.kind)}
              className={clsx(
                'flex flex-col items-start gap-2 p-4 rounded-xl text-left transition border',
                active
                  ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-dark'
                  : 'border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
              )}
            >
              <div className="flex items-center gap-2">
                <span
                  className={clsx(
                    'w-9 h-9 rounded-xl flex items-center justify-center',
                    it.kind === 'saving'
                      ? 'bg-income-soft dark:bg-income-soft-dark text-income'
                      : 'bg-expense-soft dark:bg-expense-soft-dark text-expense',
                  )}
                >
                  {it.icon}
                </span>
                <span className="text-sm font-medium">{kindLabel(it.kind)}</span>
                {active && (
                  <IconCircleCheckFilled
                    size={14}
                    className="text-text dark:text-text-dark ml-auto"
                  />
                )}
              </div>
              <div className="text-xs text-text-muted">{it.desc}</div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ──────────────────── 第二步：选择 subtype ──────────────────── */

function SubtypePicker({
  kind,
  picked,
  onPick,
}: {
  kind: GoalKind;
  picked: string;
  onPick: (opt: GoalSubtypeOption) => void;
}) {
  const list = kind === 'saving' ? SAVING_SUBTYPES : REPAYMENT_SUBTYPES;
  return (
    <div className="space-y-4">
      <div className="text-sm text-text-muted">
        第二步 · 选择 {kindLabel(kind)} 子类
      </div>
      <div className="grid grid-cols-4 gap-2">
        {list.map((opt) => {
          const active = picked === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onPick(opt)}
              className={clsx(
                'flex flex-col items-center justify-center gap-1.5 p-3 rounded-xl text-center transition border',
                active
                  ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-dark'
                  : 'border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
              )}
            >
              <span
                className="w-9 h-9 rounded-lg flex items-center justify-center text-base"
                style={{ background: `${opt.color}22`, color: opt.color }}
              >
                {opt.icon}
              </span>
              <span className="text-xs">{opt.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ──────────────────── 第三步：表单 ──────────────────── */

interface FormStepProps {
  form: FormState;
  setForm: (next: FormState) => void;
  accounts: Account[];
  submitted: boolean;
  nameInvalid: boolean;
  nameTooLong: boolean;
  targetTooLong: boolean;
  currentTooLong: boolean;
  targetInvalid: boolean;
  currentInvalid: boolean;
}

function FormStep({
  form,
  setForm,
  accounts,
  submitted,
  nameInvalid,
  nameTooLong,
  targetTooLong,
  currentTooLong,
  targetInvalid,
  currentInvalid,
}: FormStepProps) {
  const accountOptions = useMemo(
    () => [
      { value: '', label: '不关联账户' },
      ...accounts
        .filter((a) => a.type !== 'credit' && a.type !== 'debt')
        .map((a) => ({ value: String(a.id), label: a.name })),
    ],
    [accounts],
  );

  return (
    <div className="space-y-5">
      <div className="text-sm text-text-muted">填写目标详情</div>

      {/* 名称 */}
      <Field label="目标名称" required>
        <Input
          placeholder={`如：${form.subtype}储蓄`}
          value={form.name}
          maxLength={NAME_LIMIT}
          invalid={nameInvalid || nameTooLong}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <FieldHint
          hint={`${form.name.length}/${NAME_LIMIT}`}
          error={nameTooLong ? '名称过长' : nameInvalid ? '名称不能为空' : ''}
        />
      </Field>

      {/* 金额 */}
      <div className="grid grid-cols-2 gap-3">
        <Field label="目标金额" required>
          <Input
            prefix={<span>¥</span>}
            placeholder="0.00"
            value={form.targetAmount}
            maxLength={TARGET_LIMIT}
            invalid={targetTooLong || targetInvalid}
            onChange={(e) => setForm({ ...form, targetAmount: e.target.value })}
          />
          <FieldHint
            hint={`${form.targetAmount.length}/${TARGET_LIMIT}`}
            error={
              targetInvalid
                ? '目标金额必须大于 0'
                : targetTooLong
                  ? '过长'
                  : ''
            }
          />
        </Field>
        <Field
          label={form.kind === 'saving' ? '当前已存金额' : '当前已还金额'}
        >
          <Input
            prefix={<span>¥</span>}
            placeholder="0.00"
            value={form.currentAmount}
            maxLength={CURRENT_LIMIT}
            invalid={currentTooLong || currentInvalid}
            onChange={(e) =>
              setForm({ ...form, currentAmount: e.target.value })
            }
          />
          <FieldHint
            hint={`${form.currentAmount.length}/${CURRENT_LIMIT}`}
            error={currentInvalid ? '不能为负数' : currentTooLong ? '过长' : ''}
          />
        </Field>
      </div>

      {/* 截止日期 */}
      <Field label="截止日期" hint="可选；用于倒计时提醒">
        <Input
          type="date"
          value={form.deadline}
          onChange={(e) => setForm({ ...form, deadline: e.target.value })}
        />
      </Field>

      {/* 关联账户 */}
      <Field label="关联账户" hint="可选；存入/取出时可联动该账户">
        <Select
          options={accountOptions}
          value={form.accountId === undefined ? '' : String(form.accountId)}
          onChange={(e) =>
            setForm({
              ...form,
              accountId: e.target.value === '' ? undefined : Number(e.target.value),
            })
          }
        />
      </Field>

      {/* 图标 / 颜色 */}
      <Field label="颜色">
        <div className="flex flex-wrap gap-2">
          {COLOR_CHOICES.map((c) => {
            const active = form.color === c;
            return (
              <button
                key={c}
                type="button"
                onClick={() => setForm({ ...form, color: c })}
                className={clsx(
                  'w-8 h-8 rounded-full transition border-2',
                  active
                    ? 'border-text dark:border-bg-card scale-110'
                    : 'border-transparent hover:scale-105',
                )}
                style={{ background: c }}
                aria-label={`颜色 ${c}`}
              />
            );
          })}
        </div>
      </Field>

      <Field label="图标">
        <div className="flex items-center gap-3">
          <div
            className="w-12 h-12 rounded-xl flex items-center justify-center text-2xl"
            style={{ background: `${form.color}22`, color: form.color }}
          >
            {form.icon}
          </div>
          <Input
            placeholder="输入 emoji 或字符"
            maxLength={4}
            value={form.icon}
            onChange={(e) => setForm({ ...form, icon: e.target.value })}
          />
        </div>
      </Field>

      {submitted && (nameInvalid || nameTooLong || targetInvalid) && (
        <div className="text-xs text-expense">
          {nameInvalid && '请填写目标名称；'}
          {nameTooLong && `名称不能超过 ${NAME_LIMIT} 字；`}
          {targetInvalid && '目标金额必须大于 0；'}
        </div>
      )}
    </div>
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
        <label className="text-sm">
          {label}
          {required && <span className="text-expense ml-0.5">*</span>}
        </label>
        {hint && <span className="text-xs text-text-muted">{hint}</span>}
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
      <span className="text-text-muted tabular-nums">{hint}</span>
    </div>
  );
}

export default GoalFormModal;
