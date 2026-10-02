/**
 * 账户创建 / 编辑模态（两步）
 *
 * - 第一步：选择账户类型（资产 / 负债 分组）
 * - 第二步：填写账户信息（名称、余额、备注、标签、计入资产）
 *
 * 通过 props.account 传入已有账户即可进入"编辑"模式（自动跳过第一步）。
 */
import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import {
  IconCircleCheckFilled,
  IconTrendingUp,
  IconTrendingDown,
  IconCheck,
  IconChevronLeft,
} from '@tabler/icons-react';
import {
  Button,
  Input,
  Modal,
  Switch,
  Textarea,
} from '@/components/ui';
import { useSpaceId } from '@/db';
import type { Account, AccountType, Tag } from '@/db';
import { apiFetch, useApi } from '@/hooks/useApi';
import {
  ACCOUNT_TYPE_META,
  ACCOUNT_TONE,
  ACCOUNT_TONE_BG,
  ASSET_TYPES,
  DEBT_TYPES,
  renderTypeIcon,
} from './metadata';
import { parseAmount } from './format';

interface AccountFormModalProps {
  open: boolean;
  onClose: () => void;
  /** 编辑模式：传入已有账户；省略则进入"新建" */
  account?: Account | null;
  /** 保存成功后回调（父组件用来 refetch 列表） */
  onSaved?: () => void;
}

type Step = 'pick-type' | 'fill-form';

interface FormState {
  name: string;
  balance: string;
  remark: string;
  tagIds: number[];
  includeInNetAsset: boolean;
}

const NAME_LIMIT = 20;
const REMARK_LIMIT = 200;
const DEFAULT_FORM: FormState = {
  name: '',
  balance: '',
  remark: '',
  tagIds: [],
  includeInNetAsset: true,
};

export function AccountFormModal({ open, onClose, account, onSaved }: AccountFormModalProps) {
  const isEdit = !!account;
  const [step, setStep] = useState<Step>(isEdit ? 'fill-form' : 'pick-type');
  const [pickedType, setPickedType] = useState<AccountType | null>(
    account?.type ?? null,
  );
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const spaceId = useSpaceId();

  // 每次打开 / 切换编辑对象时，重置状态
  useEffect(() => {
    if (!open) return;
    setStep(isEdit ? 'fill-form' : 'pick-type');
    setPickedType(account?.type ?? null);
    setForm(
      account
        ? {
            name: account.name,
            balance: account.balance === 0 ? '' : String(account.balance),
            remark: account.remark ?? '',
            tagIds: account.tagIds ?? [],
            includeInNetAsset: account.includeInNetAsset,
          }
        : DEFAULT_FORM,
    );
    setSubmitted(false);
    setSaveError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, account?.id]);

  const { data: tags } = useApi<Tag[]>('/api/tags');
  // 后端按 id 返回；表单下拉保持原来的按名称排序。
  const tagsByName = useMemo(
    () => [...(tags ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
    [tags],
  );

  const trimmedName = form.name.trim();
  const nameInvalid = submitted && trimmedName.length === 0;
  const nameTooLong = form.name.length > NAME_LIMIT;
  const remarkTooLong = form.remark.length > REMARK_LIMIT;

  const canConfirm =
    trimmedName.length > 0 &&
    !nameTooLong &&
    !remarkTooLong &&
    !!pickedType;

  const title = isEdit ? '编辑账户' : '新建账户';

  function handleClose() {
    onClose();
  }

  async function handleConfirm() {
    setSubmitted(true);
    if (!canConfirm || !pickedType) {
      // 表单未通过：若还在第一步则留在第一步
      if (!pickedType) setStep('pick-type');
      return;
    }
    const remark = form.remark.trim();
    // 后端 create/update 接受的字段：name/type/balance/remark/tagIds/includeInNetAsset/spaceId
    const payload = {
      type: pickedType,
      name: trimmedName,
      balance: parseAmount(form.balance),
      remark: remark === '' ? null : remark,
      tagIds: form.tagIds,
      includeInNetAsset: form.includeInNetAsset,
      spaceId: account?.spaceId ?? spaceId,
    };
    setSaving(true);
    setSaveError(null);
    try {
      if (account?.id != null) {
        await apiFetch(`/api/accounts/${account.id}`, 'PUT', payload);
      } else {
        await apiFetch('/api/accounts', 'POST', payload);
      }
      onSaved?.();
      handleClose();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title={title}
      width={520}
      footer={
        <>
          {step === 'fill-form' && !isEdit && (
            <Button
              variant="ghost"
              icon={<IconChevronLeft size={16} />}
              onClick={() => setStep('pick-type')}
            >
              上一步
            </Button>
          )}
          <div className="flex-1" />
          {step === 'pick-type' ? (
            <Button
              variant="primary"
              disabled={!pickedType}
              onClick={() => setStep('fill-form')}
              icon={<IconCheck size={16} />}
            >
              下一步
            </Button>
          ) : (
            <Button
              variant="primary"
              disabled={!canConfirm || saving}
              onClick={handleConfirm}
            >
              {saving ? '保存中…' : '确认'}
            </Button>
          )}
        </>
      }
    >
      {step === 'pick-type' && !isEdit ? (
        <TypePicker
          picked={pickedType}
          onPick={(t) => setPickedType(t)}
        />
      ) : (
        <FormStep
          type={pickedType!}
          form={form}
          setForm={setForm}
          tags={tagsByName}
          submitted={submitted}
          saveError={saveError}
          nameInvalid={nameInvalid}
          nameTooLong={nameTooLong}
          remarkTooLong={remarkTooLong}
        />
      )}
    </Modal>
  );
}

// ────────────────────────────────────────────────────────────
// 第一步：选择类型
// ────────────────────────────────────────────────────────────

function TypePicker({
  picked,
  onPick,
}: {
  picked: AccountType | null;
  onPick: (t: AccountType) => void;
}) {
  return (
    <div className="space-y-5">
      <div className="text-sm text-text-muted dark:text-text-muted-dark">选择账户类型</div>

      <Group title="资产" icon={<IconTrendingUp size={14} className="text-income" />}>
        {ASSET_TYPES.map((t) => (
          <TypeOption
            key={t}
            type={t}
            selected={picked === t}
            onClick={() => onPick(t)}
          />
        ))}
      </Group>

      <Group title="负债" icon={<IconTrendingDown size={14} className="text-expense" />}>
        {DEBT_TYPES.map((t) => (
          <TypeOption
            key={t}
            type={t}
            selected={picked === t}
            onClick={() => onPick(t)}
          />
        ))}
      </Group>
    </div>
  );
}

function Group({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-2 text-xs text-text-muted dark:text-text-muted-dark">
        {icon}
        <span>{title}</span>
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function TypeOption({
  type,
  selected,
  onClick,
}: {
  type: AccountType;
  selected: boolean;
  onClick: () => void;
}) {
  const meta = ACCOUNT_TYPE_META[type];
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'w-full flex items-start gap-3 p-3 rounded-xl text-left transition border',
        selected
          ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-dark'
          : 'border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
      )}
    >
      <div
        className={clsx(
          'w-9 h-9 rounded-xl flex items-center justify-center flex-none',
          ACCOUNT_TONE_BG[type],
          ACCOUNT_TONE[type],
        )}
      >
        {renderTypeIcon(type, 18, 'text-inherit')}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-text dark:text-text-dark">{meta.label}</span>
          {selected && (
            <IconCircleCheckFilled size={14} className="text-income" />
          )}
        </div>
        <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">{meta.description}</div>
      </div>
    </button>
  );
}

// ────────────────────────────────────────────────────────────
// 第二步：填写表单
// ────────────────────────────────────────────────────────────

interface FormStepProps {
  type: AccountType;
  form: FormState;
  setForm: (next: FormState) => void;
  tags: Array<{ id?: number; name: string }>;
  submitted: boolean;
  nameInvalid: boolean;
  nameTooLong: boolean;
  remarkTooLong: boolean;
  /** 保存失败时的服务端错误 */
  saveError?: string | null;
}

function FormStep({
  type,
  form,
  setForm,
  tags,
  submitted,
  nameInvalid,
  nameTooLong,
  remarkTooLong,
  saveError,
}: FormStepProps) {
  const meta = ACCOUNT_TYPE_META[type];

  const tagOptions = useMemo(
    () =>
      tags.map((t) => ({
        value: String(t.id),
        label: t.name,
      })),
    [tags],
  );

  return (
    <div className="space-y-5">
      {/* 类型徽标 */}
      <div
        className={clsx(
          'inline-flex items-center gap-2 px-2.5 h-7 rounded-lg text-xs',
          ACCOUNT_TONE_BG[type],
        )}
      >
        {renderTypeIcon(type, 14, 'text-inherit')}
        <span className="font-medium text-text dark:text-text-dark">{meta.label}账户</span>
      </div>

      {/* 名称 */}
      <Field label="账户名称" required>
        <Input
          placeholder={`请输入${meta.label}账户名称`}
          value={form.name}
          maxLength={NAME_LIMIT}
          invalid={nameInvalid || nameTooLong}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <Counter
          current={form.name.length}
          max={NAME_LIMIT}
          invalid={nameTooLong}
          errorHint={nameInvalid ? '账户名称不能为空' : undefined}
        />
      </Field>

      {/* 余额 */}
      <Field label="账户余额" hint="支持正负数；负数表示欠款">
        <Input
          prefix={<span>¥</span>}
          placeholder="0.00"
          inputMode="decimal"
          value={form.balance}
          onChange={(e) => setForm({ ...form, balance: e.target.value })}
        />
      </Field>

      {/* 备注 */}
      <Field label="备注">
        <Textarea
          placeholder="备注（选填）"
          maxLength={REMARK_LIMIT}
          invalid={remarkTooLong}
          value={form.remark}
          onChange={(e) => setForm({ ...form, remark: e.target.value })}
        />
        <Counter current={form.remark.length} max={REMARK_LIMIT} invalid={remarkTooLong} />
      </Field>

      {/* 标签 */}
      <Field label="标签" hint="可选择多个标签">
        <TagMultiSelect
          options={tagOptions}
          value={form.tagIds}
          onChange={(ids) => setForm({ ...form, tagIds: ids })}
        />
      </Field>

      {/* 计入资产 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-text dark:text-text-dark">计入资产</div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark mt-0.5">
            关闭后将不计入净资产计算
          </div>
        </div>
        <Switch
          checked={form.includeInNetAsset}
          onChange={(v) => setForm({ ...form, includeInNetAsset: v })}
        />
      </div>

      {submitted && (nameInvalid || nameTooLong || remarkTooLong) && (
        <div className="text-xs text-expense">
          {nameInvalid && '账户名称不能为空；'}
          {nameTooLong && `账户名称不能超过 ${NAME_LIMIT} 字；`}
          {remarkTooLong && `备注不能超过 ${REMARK_LIMIT} 字；`}
        </div>
      )}

      {saveError && (
        <div className="text-xs text-expense">保存失败：{saveError}</div>
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
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        {/* Modal 通过 portal 挂到 body，脱离 AppLayout 的 text-text 根色，
            因此模态内所有文字都必须显式声明颜色，否则在暗黑模式下会退回纯黑而不可见 */}
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

function Counter({
  current,
  max,
  invalid,
  errorHint,
}: {
  current: number;
  max: number;
  invalid?: boolean;
  errorHint?: string;
}) {
  return (
    <div className="flex justify-between text-xs">
      <span className={invalid ? 'text-expense' : 'text-text-muted dark:text-text-muted-dark'}>
        {errorHint ?? ''}
      </span>
      <span className={invalid ? 'text-expense tabular-nums' : 'text-text-muted dark:text-text-muted-dark tabular-nums'}>
        {current}/{max}
      </span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 标签多选下拉（基于原生 select + 已选 chip 列表）
// ────────────────────────────────────────────────────────────

function TagMultiSelect({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  function toggle(id: number) {
    if (value.includes(id)) {
      onChange(value.filter((x) => x !== id));
    } else {
      onChange([...value, id]);
    }
  }

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const opt = options.find((o) => Number(o.value) === id);
            if (!opt) return null;
            return (
              <button
                key={id}
                type="button"
                onClick={() => toggle(id)}
                className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-bg dark:bg-bg-card-dark border border-border dark:border-border-dark text-xs hover:border-text dark:hover:border-bg-card transition"
              >
                <span className="text-text dark:text-text-dark">{opt.label}</span>
                <span className="text-text-muted dark:text-text-muted-dark">×</span>
              </button>
            );
          })}
        </div>
      )}
      <div className="relative">
        <select
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (!v) return;
            toggle(Number(v));
            e.target.value = '';
          }}
          className="w-full h-10 px-3 pr-9 rounded-xl border border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark text-sm text-text dark:text-text-dark appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-brand/40"
        >
          <option value="" disabled>
            {value.length === 0 ? '选择标签（可多选）' : '继续添加…'}
          </option>
          {options
            .filter((o) => !value.includes(Number(o.value)))
            .map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
        </select>
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-text-muted dark:text-text-muted-dark text-xs pointer-events-none">
          ▾
        </span>
      </div>
      {options.length === 0 && (
        <div className="text-xs text-text-muted dark:text-text-muted-dark">暂无标签，可在「设置 → 标签」中添加</div>
      )}
    </div>
  );
}
