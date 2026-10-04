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
import { validateAnnualIncome, yieldInputValue } from './yield';

interface AccountFormModalProps {
  open: boolean;
  onClose: () => void;
  /** 编辑模式：传入已有账户；省略则进入"新建" */
  account?: Account | null;
  /** 保存成功后回调（父组件用来 refetch 列表） */
  onSaved?: () => void;
}

type Step = 'pick-type' | 'fill-form';

/** 年度收益按自然年归档：提交时写到"当前年"，编辑时也只回填当前年 */
function currentYear(): number {
  return new Date().getFullYear();
}

interface FormState {
  name: string;
  balance: string;
  remark: string;
  tagIds: number[];
  includeInNetAsset: boolean;
  /** 年度收益（元）原始输入；空串 = 不填 */
  annualIncome: string;
}

const NAME_LIMIT = 20;
const REMARK_LIMIT = 200;
const DEFAULT_FORM: FormState = {
  name: '',
  balance: '',
  remark: '',
  tagIds: [],
  includeInNetAsset: true,
  annualIncome: '',
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
  /**
   * 账户已保存、但年度收益没存上时的提示。
   * 单独一个 state：这类失败不该占 saveError（账户其实是存成功的），
   * 而且要把模态留住，用户才看得见"哪个字段没存上"。
   */
  const [yieldWarning, setYieldWarning] = useState<string | null>(null);
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
            // 只回填当前年的收益：latestYield 是"最近一次"的记录，
            // 去年填的 350 不该出现在今年（可能是另一年）的输入框里
            annualIncome: yieldInputValue(account.latestYield, currentYear()),
          }
        : DEFAULT_FORM,
    );
    setSubmitted(false);
    setSaveError(null);
    setYieldWarning(null);
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
  const yieldCheck = validateAnnualIncome(form.annualIncome);
  /*
   * 年度收益的红框/红字**立即**反馈，不等提交：
   * 越界时「确认」是 disabled 的，用户按不下去，
   * 若沿用账户名"提交后才提示"的写法，这个错误提示永远出不来 ——
   * 用户只会看到一个点不亮的按钮，不知道哪里错了。
   * 留空不报错（选填字段），非法数字才提示。
   */
  const yieldInvalid = !yieldCheck.ok;

  const canConfirm =
    trimmedName.length > 0 &&
    !nameTooLong &&
    !remarkTooLong &&
    !!pickedType &&
    yieldCheck.ok;

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
    setYieldWarning(null);
    try {
      // ── 1. 先把账户本身存掉（这一步失败 = 整体失败，沿用原有错误提示）
      let accountId = account?.id ?? null;
      if (accountId != null) {
        await apiFetch(`/api/accounts/${accountId}`, 'PUT', payload);
      } else {
        // 新建：必须拿到后端返回的 id，才能接着写该账户的年度收益
        const created = await apiFetch<{ id?: number }>('/api/accounts', 'POST', payload);
        accountId = created?.id ?? null;
      }

      // ── 2. 再写年度收益（可选字段：留空就完全不调这个接口）
      //
      // 这里刻意不和外层 catch 共用：账户已经存成功了，收益失败只是
      // "附加信息没存上"，不能反过来把整次保存报成失败、更不能让用户白填一遍账户。
      const yieldValue = validateAnnualIncome(form.annualIncome).value;
      let yieldFailed = false;
      if (accountId != null && yieldValue != null) {
        try {
          await apiFetch(`/api/accounts/${accountId}/yields/${currentYear()}`, 'PUT', {
            annualIncome: yieldValue,
          });
        } catch (e) {
          yieldFailed = true;
          setYieldWarning(
            `账户已保存，但年度收益没存上：${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }

      onSaved?.();
      // 年度收益没存上时把模态留着，用户才能看见提示并手动关闭
      if (!yieldFailed) handleClose();
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
          yieldWarning={yieldWarning}
          nameInvalid={nameInvalid}
          nameTooLong={nameTooLong}
          remarkTooLong={remarkTooLong}
          yieldInvalid={yieldInvalid}
          yieldError={yieldInvalid ? yieldCheck.error : null}
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
  /** 年度收益输入非法（且已提交过一次，用于抑制首次打开就飘红） */
  yieldInvalid: boolean;
  /** 年度收益非法原因 */
  yieldError: string | null;
  /** 账户已保存、年度收益没存上的提示 */
  yieldWarning?: string | null;
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
  yieldInvalid,
  yieldError,
  yieldWarning,
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

      {/* 年度收益金额 */}
      <Field label="年度收益（元）" hint="选填，该账户今年实际产生的收益">
        <Input
          placeholder="如 350，留空表示不统计"
          inputMode="decimal"
          value={form.annualIncome}
          invalid={yieldInvalid}
          prefix={<span>¥</span>}
          data-testid="yield-percent-input"
          onChange={(e) => setForm({ ...form, annualIncome: e.target.value })}
        />
        {yieldInvalid && yieldError && (
          <div className="text-xs text-expense" data-testid="yield-error">
            {yieldError}
          </div>
        )}
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

      {/*
       * 账户已存成功、只有收益率失败：这不是错误，用 brand 蓝提示即可，
       * 让用户分清"整个保存失败"（红/绿 text-expense）和"附加信息没存上"。
       * tailwind.config.js 不在本次授权范围内，不新增语义 token。
       */}
      {yieldWarning && (
        <div className="text-xs text-brand" data-testid="yield-warning">
          {yieldWarning}
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
