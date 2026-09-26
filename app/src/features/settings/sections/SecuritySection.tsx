/**
 * 设置 → 数据安全
 *
 * - 导出全部表为 JSON 下载
 * - 清空数据库（二次确认）
 */
import { useState } from 'react';
import {
  IconDownload,
  IconTrash,
  IconAlertTriangle,
  IconShieldLock,
} from '@tabler/icons-react';
import { Button, Card, Modal } from '@/components/ui';
import { db } from '@/db';

/** Dexie 表名 -> DB key 列表 */
const ALL_TABLES = [
  'accounts',
  'transactions',
  'goals',
  'categories',
  'tags',
  'merchants',
  'reports',
  'aiModels',
  'kv',
] as const;

type TableName = (typeof ALL_TABLES)[number];

async function exportAll(): Promise<Record<TableName, unknown[]>> {
  const out = {} as Record<TableName, unknown[]>;
  for (const t of ALL_TABLES) {
    // 通过 as any 避免把 Table union 写得过于复杂
    out[t] = await (db as unknown as Record<TableName, { toArray: () => Promise<unknown[]> }>)[t].toArray();
  }
  return out;
}

function downloadJson(data: unknown, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // 异步释放
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SecuritySection() {
  const [exporting, setExporting] = useState(false);
  const [exportToast, setExportToast] = useState<string | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [clearing, setClearing] = useState(false);

  async function handleExport() {
    setExporting(true);
    setExportToast(null);
    try {
      const data = await exportAll();
      const ts = new Date()
        .toISOString()
        .replace(/[:T]/g, '-')
        .replace(/\..+$/, '');
      downloadJson(
        {
          version: 1,
          exportedAt: Date.now(),
          data,
        },
        `hifin-export-${ts}.json`,
      );
      setExportToast('导出成功，文件已下载到本地。');
      setTimeout(() => setExportToast(null), 2500);
    } catch (e) {
      setExportToast('导出失败：' + (e as Error).message);
      setTimeout(() => setExportToast(null), 3000);
    } finally {
      setExporting(false);
    }
  }

  async function handleClear() {
    if (confirmText !== '清空数据') return;
    setClearing(true);
    try {
      // 逐表 clear，保证 seed 不被同时干掉时也能完整清除
      for (const t of ALL_TABLES) {
        await (
          db as unknown as Record<TableName, { clear: () => Promise<void> }>
        )[t].clear();
      }
      setClearOpen(false);
      setConfirmText('');
      // 重新跑 seed，使 categories / tags 仍有默认
      // 重新载入页面以确保 jotai 状态与 db 状态同步
      window.location.reload();
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="导出数据">
        <div className="space-y-3 max-w-[560px]">
          <div className="text-sm text-text-muted">
            导出全部表为 JSON 文件（含账户、流水、目标、分类、标签、商户、报表、AI
            模型与偏好），便于备份或迁移。
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="primary"
              icon={<IconDownload size={16} />}
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? '导出中…' : '导出全部为 JSON'}
            </Button>
            {exportToast && (
              <span className="text-xs text-text-muted">{exportToast}</span>
            )}
          </div>
        </div>
      </Card>

      <Card title="清空数据库">
        <div className="space-y-3 max-w-[560px]">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-expense-soft dark:bg-expense-soft-dark text-expense text-sm">
            <IconAlertTriangle size={16} className="flex-none mt-0.5" />
            <div>
              该操作将<strong>永久删除</strong>本地全部数据，包括账户、流水、目标、分类、标签、商户、报表与 AI
              模型配置。请先导出备份。清空后默认分类 / 标签将自动重新写入。
            </div>
          </div>
          <Button
            variant="danger"
            icon={<IconTrash size={16} />}
            onClick={() => setClearOpen(true)}
          >
            清空数据库
          </Button>
        </div>
      </Card>

      <Modal
        open={clearOpen}
        onClose={() => {
          if (!clearing) {
            setClearOpen(false);
            setConfirmText('');
          }
        }}
        title={
          <span className="inline-flex items-center gap-2">
            <IconShieldLock size={16} />
            清空数据库
          </span>
        }
        width={460}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                if (clearing) return;
                setClearOpen(false);
                setConfirmText('');
              }}
              disabled={clearing}
            >
              取消
            </Button>
            <Button
              variant="danger"
              onClick={handleClear}
              disabled={confirmText !== '清空数据' || clearing}
            >
              {clearing ? '清空中…' : '确认清空'}
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="text-sm">
            为了避免误操作，请在下方输入{' '}
            <span className="px-1.5 py-0.5 rounded-md bg-bg dark:bg-bg-card-dark text-text dark:text-text-dark font-medium">
              清空数据
            </span>{' '}
            后再确认。
          </div>
          <input
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder="清空数据"
            className="w-full h-10 px-3 rounded-xl border border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark text-sm outline-none focus:ring-2 focus:ring-brand/40"
          />
        </div>
      </Modal>
    </div>
  );
}