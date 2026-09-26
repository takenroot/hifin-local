/**
 * 报表列表页 /report/list
 *
 * - 空状态：引导新建
 * - 列表：卡片网格，每张卡显示报表名称 / 描述 / 模板 + 进入详情 + 删除
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconChartBar,
  IconPlus,
  IconEye,
  IconShare,
  IconChevronRight,
  IconTrash,
} from '@tabler/icons-react';
import {
  Button,
  Card,
  EmptyState,
  PageHeader,
} from '@/components/ui';
import { db, type Report } from '@/db';
import { ReportFormModal } from './ReportFormModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import { getTemplateKey, templateMeta } from './metadata';
import dayjs from 'dayjs';

export default function ReportList() {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<Report | null>(null);

  const reports = useLiveQuery(
    () => db.reports.orderBy('createdAt').toArray(),
    [],
  );
  const isEmpty = (reports?.length ?? 0) === 0;

  async function handleDeleteConfirm() {
    if (!deleting?.id) return;
    await db.reports.delete(deleting.id);
    setDeleting(null);
  }

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="数据报表"
        icon={<IconChartBar size={18} />}
        actions={
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-2 text-text-muted">
              <IconEye size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
              <IconShare size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
            </div>
            {!isEmpty && (
              <Button
                icon={<IconPlus size={16} />}
                onClick={() => setCreateOpen(true)}
              >
                新建报表
              </Button>
            )}
          </div>
        }
      />

      <div className="p-8 max-w-[1200px]">
        {isEmpty ? (
          <Card>
            <EmptyState
              title="创建报表"
              description={
                <>
                  <div>报表展示你的财务全貌</div>
                  <div>包括：月度收支、年度总结、资产分布、预算执行等</div>
                </>
              }
              action={
                <Button
                  icon={<IconPlus size={16} />}
                  onClick={() => setCreateOpen(true)}
                >
                  新建报表
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {(reports ?? []).map((r) => (
              <ReportCard
                key={r.id}
                report={r}
                onOpen={() => navigate(`/report/detail/${r.id}`)}
                onDelete={() => setDeleting(r)}
              />
            ))}
          </div>
        )}
      </div>

      <ReportFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
      <DeleteConfirmModal
        open={!!deleting}
        title="删除报表"
        message={
          <>
            确定要删除报表「
            <span className="font-medium">{deleting?.name}</span>
            」吗？此操作不可撤销。
          </>
        }
        onClose={() => setDeleting(null)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

/* ─────────────────── 报表卡片 ─────────────────── */

function ReportCard({
  report,
  onOpen,
  onDelete,
}: {
  report: Report;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const meta = templateMeta(getTemplateKey(report));
  return (
    <div className="card !p-5 flex flex-col gap-3 hover:shadow-md transition group">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="w-10 h-10 rounded-xl flex items-center justify-center text-lg flex-none"
            style={{ background: `${meta.tone}22`, color: meta.tone }}
          >
            {report.icon ?? meta.icon}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium truncate">{report.name}</div>
            <div className="mt-0.5 text-xs text-text-muted flex items-center gap-1.5">
              <span>{meta.label}</span>
              <span>·</span>
              <span>{dayjs(report.createdAt).format('YYYY-MM-DD')}</span>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1.5 rounded-lg text-text-muted hover:text-expense hover:bg-bg dark:hover:bg-bg-card-dark"
          aria-label="删除"
        >
          <IconTrash size={14} />
        </button>
      </div>

      {report.description && (
        <div className="text-xs text-text-muted line-clamp-3 whitespace-pre-line min-h-[2.5rem]">
          {report.description}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between pt-1">
        <span
          className={clsx(
            'inline-flex items-center px-2 h-5 rounded-md text-xs',
            'bg-bg dark:bg-bg-card-dark text-text-muted',
          )}
        >
          {meta.label}
        </span>
        <button
          type="button"
          onClick={onOpen}
          className="text-xs text-text-muted hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
        >
          查看详情 <IconChevronRight size={12} />
        </button>
      </div>
    </div>
  );
}
