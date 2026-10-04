/**
 * 设置 → 数据安全
 *
 * - 导出：逐个拉取 REST 端点聚合成一份 JSON 下载（不再读 IndexedDB）
 * - 清空：core 没有 POST /api/reset，因此前端逐表 DELETE
 *
 * core 侧的两处硬限制（前端如实提示，不做静默吞掉）：
 *   1. /api/categories 只有 GET + POST，没有 DELETE —— 分类无法清空；
 *   2. /api/spaces/:id 对默认空间（id=1）与非空空间返回 409。
 * 所有 DELETE 端点返回 204 空体，因此不走 apiFetch。
 */
import { useState } from 'react';
import {
  IconDownload,
  IconTrash,
  IconAlertTriangle,
  IconShieldLock,
} from '@tabler/icons-react';
import { Button, Card, Modal } from '@/components/ui';
import { kvGet, restDelete } from '../restApi';

/** 导出覆盖的资源（导出键名沿用原 Dexie 表名，方便旧备份对照）。 */
const EXPORT_SOURCES: Array<{ key: string; url: string }> = [
  { key: 'accounts', url: '/api/accounts' },
  { key: 'transactions', url: '/api/transactions' },
  { key: 'goals', url: '/api/goals' },
  { key: 'categories', url: '/api/categories' },
  { key: 'tags', url: '/api/tags' },
  { key: 'merchants', url: '/api/merchants' },
  { key: 'budgets', url: '/api/budgets' },
  { key: 'rules', url: '/api/rules' },
  { key: 'reports', url: '/api/reports' },
  { key: 'aiModels', url: '/api/ai-models?hideApiKey=0' },
  { key: 'spaces', url: '/api/spaces' },
];

/** kv 没有"列出全部键"的端点，按已知键逐个取。 */
const EXPORT_KV_KEYS = ['nickname', 'userId', 'email', 'ai.defaultModelId'];

/**
 * 清空顺序：先删子表再删父表。
 * - categories 无 DELETE 端点，跳过；
 * - spaces 只删非默认且已清空的（否则 409）。
 */
const CLEAR_ORDER: Array<{ key: string; url: string }> = [
  { key: 'transactions', url: '/api/transactions' },
  { key: 'budgets', url: '/api/budgets' },
  { key: 'goals', url: '/api/goals' },
  { key: 'reports', url: '/api/reports' },
  { key: 'rules', url: '/api/rules' },
  { key: 'tags', url: '/api/tags' },
  { key: 'merchants', url: '/api/merchants' },
  { key: 'aiModels', url: '/api/ai-models' },
  { key: 'accounts', url: '/api/accounts' },
];

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return (await r.json()) as T;
}

interface IdRow {
  id?: number | null;
}

async function exportAll(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};

  // 集合型资源并行拉取；任一失败只记录，不中断整体导出
  const results = await Promise.allSettled(
    EXPORT_SOURCES.map(async (s) => [s.key, await fetchJson<unknown>(s.url)] as const),
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const key = EXPORT_SOURCES[i].key;
    out[key] = r.status === 'fulfilled' ? r.value[1] : { error: String(r.reason) };
  }

  const kv: Record<string, unknown> = {};
  for (const k of EXPORT_KV_KEYS) {
    try {
      kv[k] = (await kvGet(k)) ?? null;
    } catch (e) {
      kv[k] = { error: String(e) };
    }
  }
  out.kv = kv;

  return out;
}

async function clearAll(): Promise<{ cleared: string[]; skipped: string[] }> {
  const cleared: string[] = [];
  const skipped: string[] = [];

  for (const t of CLEAR_ORDER) {
    try {
      const rows = await fetchJson<IdRow[]>(t.url);
      for (const row of rows) {
        if (row.id == null) continue;
        try {
          await restDelete(`${t.url}/${row.id}`);
        } catch {
          // 单条失败不阻断整表
        }
      }
      cleared.push(t.key);
    } catch (e) {
      skipped.push(`${t.key}（${String(e)}）`);
    }
  }

  // 空间：先删数据再删空间；默认空间 id=1 始终 409，忽略
  try {
    const spaces = await fetchJson<IdRow[]>('/api/spaces');
    for (const s of spaces) {
      if (s.id == null || s.id === 1) continue;
      try {
        await restDelete(`/api/spaces/${s.id}`);
        cleared.push(`spaces#${s.id}`);
      } catch {
        // 非空空间 409：保留并提示
        skipped.push(`spaces#${s.id}（空间非空，服务端拒绝删除）`);
      }
    }
  } catch (e) {
    skipped.push(`spaces（${String(e)}）`);
  }

  // categories 无 DELETE 端点
  skipped.push('categories（服务端未提供删除端点）');

  return { cleared, skipped };
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
  const [clearResult, setClearResult] = useState<string | null>(null);

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
          version: 2,
          source: 'hifin-core REST',
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
    setClearResult(null);
    try {
      const { cleared, skipped } = await clearAll();
      setClearResult(
        [
          cleared.length > 0 ? `已清空：${cleared.join('、')}` : null,
          skipped.length > 0 ? `未清空：${skipped.join('；')}` : null,
        ]
          .filter(Boolean)
          .join(' | '),
      );
      setClearOpen(false);
      setConfirmText('');
      // 不再自动 reload：core 的 ensureSeed 只在服务启动时跑，
      // reload 不会补回种子数据，反而会把上面的清空结果提示冲掉。
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card title="导出数据">
        <div className="space-y-3 max-w-[560px]">
          <div className="text-sm text-text-muted dark:text-text-muted-dark">
            逐个拉取本地 REST 服务（core）上的全部资源，聚合为一份 JSON 文件（含账户、流水、目标、分类、标签、商户、预算、规则、报表、AI
            模型、空间与偏好设置），便于备份或迁移。
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
              <span className="text-xs text-text-muted dark:text-text-muted-dark">{exportToast}</span>
            )}
          </div>
        </div>
      </Card>

      <Card title="清空数据库">
        <div className="space-y-3 max-w-[560px]">
          <div className="flex items-start gap-2 p-3 rounded-xl bg-danger-soft dark:bg-danger-soft-dark text-danger dark:text-danger-dark text-sm">
            <IconAlertTriangle size={16} className="flex-none mt-0.5" />
            <div>
              该操作将<strong>永久删除</strong>本地服务上的全部数据，包括账户、流水、目标、标签、商户、报表、规则、预算与 AI
              模型配置。请先导出备份。
              <div className="mt-1 text-xs">
                注：服务端未提供分类删除端点，分类与默认空间（id=1）会保留。
              </div>
            </div>
          </div>
          <Button
            variant="danger"
            icon={<IconTrash size={16} />}
            onClick={() => setClearOpen(true)}
          >
            清空数据库
          </Button>
          {clearResult && (
            <div className="text-xs text-text-muted dark:text-text-muted-dark break-words">{clearResult}</div>
          )}
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
              className="disabled:opacity-50 disabled:cursor-not-allowed"
            >
              取消
            </Button>
            <Button
              variant="danger"
              onClick={handleClear}
              disabled={confirmText !== '清空数据' || clearing}
              className="disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {clearing ? '清空中…' : '确认清空'}
            </Button>
          </>
        }
      >
        {/* 根节点自带前景色：Modal 走 portal，脱离 AppLayout 的 text-text 根节点 */}
        <div className="space-y-3 text-text dark:text-text-dark">
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
            className="w-full h-10 px-3 rounded-xl border border-border dark:border-border-dark bg-bg-card dark:bg-bg-card-dark text-sm text-text dark:text-text-dark outline-none focus:ring-2 focus:ring-brand/40 placeholder:text-text-muted dark:placeholder:text-text-muted-dark"
          />
        </div>
      </Modal>
    </div>
  );
}