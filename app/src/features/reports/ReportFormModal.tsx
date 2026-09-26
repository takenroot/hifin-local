/**
 * 新建 / 编辑报表模态
 *
 * 字段：名称（0/20）、描述（0/200）、模板（四选一）、图标
 */
import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { IconCheck } from '@tabler/icons-react';
import {
  Button,
  Input,
  Modal,
  Textarea,
} from '@/components/ui';
import { db, type Report } from '@/db';
import {
  REPORT_COLOR_CHOICES,
  REPORT_ICON_CHOICES,
  REPORT_TEMPLATES,
  type ReportTemplate,
} from './metadata';

interface Props {
  open: boolean;
  onClose: () => void;
  report?: Report;
}

const NAME_LIMIT = 20;
const DESC_LIMIT = 200;

interface FormState {
  name: string;
  description: string;
  template: ReportTemplate;
  icon: string;
  color: string;
}

const DEFAULT_FORM: FormState = {
  name: '',
  description: '',
  template: 'monthly',
  icon: REPORT_ICON_CHOICES[0],
  color: REPORT_COLOR_CHOICES[0],
};

function formFromReport(r: Report): FormState {
  const meta = REPORT_TEMPLATES.find((t) => t.key === r.template);
  return {
    name: r.name,
    description: r.description ?? '',
    template: (meta ? meta.key : 'monthly') as ReportTemplate,
    icon: r.icon ?? meta?.icon ?? REPORT_ICON_CHOICES[0],
    color: REPORT_COLOR_CHOICES.includes(meta?.tone ?? '')
      ? meta!.tone
      : REPORT_COLOR_CHOICES[0],
  };
}

export function ReportFormModal({ open, onClose, report }: Props) {
  const isEdit = !!report;
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(report ? formFromReport(report) : DEFAULT_FORM);
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, report?.id]);

  const trimmedName = form.name.trim();
  const nameInvalid = submitted && trimmedName.length === 0;
  const nameTooLong = form.name.length > NAME_LIMIT;
  const descTooLong = form.description.length > DESC_LIMIT;
  const canConfirm =
    trimmedName.length > 0 && !nameTooLong && !descTooLong;

  async function handleConfirm() {
    setSubmitted(true);
    if (!canConfirm) return;
    const now = Date.now();
    const payload: Omit<Report, 'id'> = {
      name: trimmedName,
      description: form.description.trim() || undefined,
      template: form.template,
      icon: form.icon,
      createdAt: report?.createdAt ?? now,
    };
    if (report?.id != null) {
      await db.reports.update(report.id, payload);
    } else {
      await db.reports.add(payload);
    }
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? '编辑报表' : '新建报表'}
      width={560}
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
        <div className="text-sm text-text-muted">
          报表展示你的财务全貌
          <div className="mt-1">
            包括：月度收支、年度总结、资产分布、预算执行等
          </div>
        </div>

        {/* 名称 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm">
              名称 <span className="text-expense">*</span>
            </label>
            <span
              className={clsx(
                'text-xs tabular-nums',
                nameTooLong ? 'text-expense' : 'text-text-muted',
              )}
            >
              {form.name.length}/{NAME_LIMIT}
            </span>
          </div>
          <Input
            placeholder="为报表起个名字"
            value={form.name}
            maxLength={NAME_LIMIT + 50} // 允许溢出让 invalid 样式生效
            invalid={nameInvalid || nameTooLong}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          {nameInvalid && (
            <div className="mt-1 text-xs text-expense">名称不能为空</div>
          )}
        </div>

        {/* 描述 */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-sm">描述</label>
            <span
              className={clsx(
                'text-xs tabular-nums',
                descTooLong ? 'text-expense' : 'text-text-muted',
              )}
            >
              {form.description.length}/{DESC_LIMIT}
            </span>
          </div>
          <Textarea
            placeholder="为报表添加描述（可选）"
            value={form.description}
            maxLength={DESC_LIMIT + 50}
            invalid={descTooLong}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>

        {/* 模板 */}
        <div>
          <div className="mb-1.5 text-sm">使用模板</div>
          <div className="grid grid-cols-2 gap-2">
            {REPORT_TEMPLATES.map((tpl) => {
              const active = form.template === tpl.key;
              return (
                <button
                  key={tpl.key}
                  type="button"
                  onClick={() =>
                    setForm({
                      ...form,
                      template: tpl.key,
                      icon: form.icon === '' ? tpl.icon : form.icon,
                      color: REPORT_COLOR_CHOICES.includes(tpl.tone)
                        ? tpl.tone
                        : form.color,
                    })
                  }
                  className={clsx(
                    'flex flex-col items-start gap-1 p-3 rounded-xl text-left border transition',
                    active
                      ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-dark'
                      : 'border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="w-7 h-7 rounded-lg flex items-center justify-center"
                      style={{ background: `${tpl.tone}22`, color: tpl.tone }}
                    >
                      {tpl.icon}
                    </span>
                    <span className="text-sm font-medium">{tpl.label}</span>
                  </div>
                  <div className="text-xs text-text-muted">
                    {tpl.description}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 图标 */}
        <div>
          <div className="mb-1.5 text-sm">图标</div>
          <div className="flex flex-wrap gap-2">
            {REPORT_ICON_CHOICES.map((ic) => {
              const active = form.icon === ic;
              return (
                <button
                  key={ic}
                  type="button"
                  onClick={() => setForm({ ...form, icon: ic })}
                  className={clsx(
                    'w-9 h-9 rounded-xl flex items-center justify-center text-lg border transition',
                    active
                      ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-dark'
                      : 'border-border dark:border-border-dark hover:bg-bg dark:hover:bg-bg-dark',
                  )}
                >
                  {ic}
                </button>
              );
            })}
          </div>
        </div>

        {/* 颜色 */}
        <div>
          <div className="mb-1.5 text-sm">颜色</div>
          <div className="flex flex-wrap gap-2">
            {REPORT_COLOR_CHOICES.map((c) => {
              const active = form.color === c;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, color: c })}
                  className={clsx(
                    'w-7 h-7 rounded-full border-2 transition',
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
        </div>

        <div className="rounded-xl border border-border dark:border-border-dark p-3 flex items-center gap-3">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg"
            style={{ background: `${form.color}22`, color: form.color }}
          >
            {form.icon}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">
              {trimmedName || '报表预览'}
            </div>
            <div className="text-xs text-text-muted">
              {
                REPORT_TEMPLATES.find((t) => t.key === form.template)?.label
              }
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export default ReportFormModal;
