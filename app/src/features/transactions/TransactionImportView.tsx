/**
 * 批量导入视图
 * ---------------------------------------------------------------
 * - Tabs：账单导入 / 历史记录
 * - 拖拽 / 点击上传 CSV，文件大小校验
 * - 平台选择（支付宝 / 微信 / 银行 / 通用）
 * - 解析按钮 → 解析 + 预览
 * - 确认导入：逐条 POST /api/transactions（余额联动由 core 完成），历史写入 /api/kv
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import {
  IconUpload,
  IconFileSpreadsheet,
  IconCloudDownload,
  IconCircleCheck,
  IconAlertCircle,
  IconBolt,
  IconWand,
} from '@tabler/icons-react';
import clsx from 'clsx';
import { Tabs, Button, Select, Badge } from '@/components/ui';
import { type Account, type Category, type TxRule, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { useApi, apiFetch } from '@/hooks/useApi';
import { PLATFORMS, parseCsvText, type ParsedTx } from './csv';
import { formatMoney } from './format';
import { applyRules } from '@/features/rules/engine';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const IMPORT_HISTORY_KEY = 'transaction:import-history';
const IMPORT_HISTORY_URL = `/api/kv/${encodeURIComponent(IMPORT_HISTORY_KEY)}`;

interface ImportBatch {
  id: string;
  platform: string;
  fileName: string;
  total: number;
  imported: number;
  at: number;
}

/** 读导入历史；键不存在时服务端返回 404，视作空历史。 */
async function readImportHistory(): Promise<ImportBatch[]> {
  try {
    const r = await fetch(IMPORT_HISTORY_URL);
    if (!r.ok) return [];
    const json = (await r.json()) as { value?: ImportBatch[] };
    return Array.isArray(json.value) ? json.value : [];
  } catch {
    return [];
  }
}

function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读取失败'));
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.readAsText(file, 'utf-8');
  });
}

export function TransactionImportView({ onImported }: { onImported?: () => void }) {
  const [activeTab, setActiveTab] = useState<'import' | 'history'>('import');

  return (
    <div className="space-y-4">
      <Tabs
        variant="line"
        activeKey={activeTab}
        onChange={(k) => setActiveTab(k as 'import' | 'history')}
        items={[
          { key: 'import', label: '账单导入', content: <ImportPanel onImported={onImported} /> },
          { key: 'history', label: '历史记录', content: <HistoryPanel /> },
        ]}
      />
    </div>
  );
}

/* -------- 导入面板 -------- */

function ImportPanel({ onImported }: { onImported?: () => void }) {
  const spaceId = useSpaceId();
  // spaceId === 0 表示"全部空间"，此时不拼 spaceId 让服务端返回全量
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;

  const { data: accountsAll } = useApi<Account[]>(`/api/accounts${spaceQ}`);
  const { data: rules } = useApi<TxRule[]>('/api/rules');
  const { data: categories } = useApi<Category[]>('/api/categories');

  const accounts = useMemo(
    () => filterBySpace(accountsAll ?? [], spaceId),
    [accountsAll, spaceId],
  );

  const [file, setFile] = useState<File | null>(null);
  const [platform, setPlatform] = useState<string>('alipay');
  const [accountId, setAccountId] = useState<number | undefined>(undefined);
  const [items, setItems] = useState<ParsedTx[]>([]);
  const [suggestions, setSuggestions] = useState<Record<number, number>>({});
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{
    imported: number;
    skipped: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!accountId && accounts[0]?.id) setAccountId(accounts[0].id);
  }, [accounts, accountId]);

  const categoryMap = useMemo(() => {
    const m = new Map<number, Category>();
    for (const c of categories ?? []) {
      if (c.id != null) m.set(c.id, c);
    }
    return m;
  }, [categories]);

  function onFiles(list: FileList | null) {
    setParseError(null);
    setItems([]);
    setSuggestions({});
    setOverrides({});
    setImportResult(null);
    if (!list || list.length === 0) return;
    const f = list[0];
    if (f.size > MAX_FILE_SIZE) {
      setParseError(`文件大小 ${(f.size / 1024 / 1024).toFixed(2)} MB 超过 10 MB 限制`);
      return;
    }
    if (!/\.(csv|txt|tsv)$/i.test(f.name)) {
      setParseError('仅支持 CSV / TXT / TSV 文件');
      return;
    }
    setFile(f);
  }

  async function doParse() {
    if (!file) {
      setParseError('请先选择文件');
      return;
    }
    setParsing(true);
    setParseError(null);
    try {
      const text = await readFileText(file);
      const result = parseCsvText(text, platform);
      setItems(result.items);
      // 自动套用规则：仅对有效行（无 rawLine）给出建议
      const next: Record<number, number> = {};
      result.items.forEach((it, idx) => {
        if (it.rawLine || !it.date || it.amount <= 0) return;
        const suggested = applyRules(
          { name: it.merchant, merchant: it.merchant, remark: it.remark },
          rules ?? [],
        );
        if (suggested != null) next[idx] = suggested;
      });
      setSuggestions(next);
      setOverrides({});
      if (result.error) setParseError(result.error);
    } catch (e) {
      setParseError((e as Error).message ?? '解析失败');
    } finally {
      setParsing(false);
    }
  }

  /** 当前有效分类（手动覆盖优先于规则建议） */
  function resolvedCategory(idx: number): number | undefined {
    if (idx in overrides) return overrides[idx];
    return suggestions[idx];
  }

  function acceptSuggestion(idx: number) {
    const v = suggestions[idx];
    if (v == null) return;
    setOverrides((prev) => ({ ...prev, [idx]: v }));
  }

  function acceptAll() {
    const next: Record<number, number> = { ...overrides };
    for (const k of Object.keys(suggestions)) {
      const i = Number(k);
      if (!(i in next)) next[i] = suggestions[i];
    }
    setOverrides(next);
  }

  function clearOverride(idx: number) {
    setOverrides((prev) => {
      const n = { ...prev };
      delete n[idx];
      return n;
    });
  }

  function overrideCategory(idx: number, catId: number | undefined) {
    setOverrides((prev) => {
      const n = { ...prev };
      if (catId == null) delete n[idx];
      else n[idx] = catId;
      return n;
    });
  }

  async function doImport() {
    if (!accountId) {
      setParseError('请先选择目标账户');
      return;
    }
    const valid = items.filter((it) => !it.rawLine && it.date && it.amount > 0);
    if (valid.length === 0) {
      setParseError('没有可导入的有效行');
      return;
    }
    setImporting(true);
    setParseError(null);
    try {
      // 逐条 POST：core 尚无批量端点，因此循环调用。
      // 注意这不再是原子的——中途失败会留下已导入的部分，这里如实回报失败条数。
      let succeeded = 0;
      let failed = 0;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.rawLine || !it.date || it.amount <= 0) continue;
        const catId = resolvedCategory(i);
        const payload: Record<string, unknown> = {
          type: it.type,
          name: it.merchant || (it.type === 'transfer' ? '转账' : '导入流水'),
          amount: it.amount,
          date: it.date,
          accountId,
          remark: it.remark,
          includeInAsset: true,
          spaceId,
        };
        // 仅在 支出/收入 类型下带分类，避免写入 null 外键
        if (catId != null && (it.type === 'expense' || it.type === 'income')) {
          payload.categoryId = catId;
        }
        try {
          await apiFetch('/api/transactions', 'POST', payload);
          succeeded++;
        } catch {
          failed++;
        }
      }

      // 写导入历史
      const now = Date.now();
      const batch: ImportBatch = {
        id: `imp-${now}-${Math.random().toString(36).slice(2, 6)}`,
        platform,
        fileName: file?.name ?? '',
        total: items.length,
        imported: succeeded,
        at: now,
      };
      const prev = await readImportHistory();
      await apiFetch(IMPORT_HISTORY_URL, 'PUT', {
        value: [batch, ...prev].slice(0, 50),
      });

      setImportResult({
        imported: succeeded,
        skipped: items.length - valid.length,
      });
      if (failed > 0) {
        setParseError(`有 ${failed} 条流水导入失败（可能重复或数据不合法），其余已成功写入`);
      }
      onImported?.();
      setItems([]);
      setSuggestions({});
      setOverrides({});
      setFile(null);
    } catch (e) {
      setParseError((e as Error).message ?? '导入失败');
    } finally {
      setImporting(false);
    }
  }

  const platformOpts = PLATFORMS.map((p) => ({ label: p.name, value: p.id }));
  const accountOpts = accounts.map((a) => ({ label: a.name, value: String(a.id) }));

  return (
    <div className="space-y-5">
      <Card title="上传账单文件">
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={clsx(
            'border-2 border-dashed rounded-2xl py-12 text-center cursor-pointer transition',
            dragOver
              ? 'border-brand bg-brand-soft/30'
              : 'border-border dark:border-border-dark hover:border-text-muted',
          )}
        >
          <div className="flex flex-col items-center gap-2 text-text-muted">
            <IconUpload size={28} />
            <div className="text-sm">点击 / 拖入文件</div>
            <div className="text-xs">支持 CSV / TXT / TSV，最大 10MB</div>
            {file && (
              <div className="mt-2 flex items-center gap-2 text-text dark:text-text-dark">
                <IconFileSpreadsheet size={16} className="text-income" />
                <span className="text-sm font-medium">{file.name}</span>
                <Badge tone="neutral">{(file.size / 1024).toFixed(1)} KB</Badge>
              </div>
            )}
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.txt,.tsv"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
        </div>
      </Card>

      {parseError && (
        <div className="text-sm text-expense bg-expense-soft dark:bg-expense-soft-dark rounded-xl px-3 py-2 flex items-start gap-2">
          <IconAlertCircle size={14} className="mt-0.5 flex-none" /> {parseError}
        </div>
      )}
      {importResult && (
        <div className="text-sm text-income bg-income-soft dark:bg-income-soft-dark rounded-xl px-3 py-2 flex items-start gap-2">
          <IconCircleCheck size={14} className="mt-0.5 flex-none" />
          成功导入 {importResult.imported} 条流水
          {importResult.skipped > 0 && `，跳过 ${importResult.skipped} 条无效行`}
        </div>
      )}

      <Card title="选择平台与账户">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-text-muted mb-1.5">导入平台</div>
            <Select
              options={platformOpts}
              value={platform}
              onChange={(e) => setPlatform(e.target.value)}
              block
            />
          </div>
          <div>
            <div className="text-sm text-text-muted mb-1.5">入账账户</div>
            <Select
              placeholder="请选择账户"
              options={accountOpts}
              value={accountId === undefined ? '' : String(accountId)}
              onChange={(e) =>
                setAccountId(e.target.value === '' ? undefined : Number(e.target.value))
              }
              block
            />
          </div>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <div className="text-xs text-text-muted">
            支持平台：{PLATFORMS.map((p) => p.name).join(' / ')}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={doParse} disabled={!file || parsing}>
              {parsing ? '解析中…' : '解析账单'}
            </Button>
            <Button onClick={doImport} disabled={items.length === 0 || importing}>
              {importing ? '导入中…' : '确认导入'}
            </Button>
          </div>
        </div>
      </Card>

      {items.length > 0 && (
        <Card
          title={`解析结果（${items.filter((x) => !x.rawLine).length} / ${items.length} 有效）`}
          flush
        >
          <div className="px-4 py-2 border-b border-border dark:border-border-dark flex items-center justify-between text-xs text-text-muted">
            <div className="flex items-center gap-2">
              <IconBolt size={12} className="text-brand" />
              {Object.keys(suggestions).length > 0
                ? `规则已为 ${Object.keys(suggestions).length} 条流水建议分类`
                : '未匹配到任何规则建议'}
            </div>
            {Object.keys(suggestions).length > 0 && (
              <Button
                size="sm"
                variant="secondary"
                icon={<IconWand size={12} />}
                onClick={acceptAll}
              >
                全部接受建议
              </Button>
            )}
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-text-muted sticky top-0 bg-bg-card dark:bg-bg-card-dark">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">日期</th>
                  <th className="text-left px-4 py-2 font-medium">商户</th>
                  <th className="text-left px-4 py-2 font-medium">类型</th>
                  <th className="text-right px-4 py-2 font-medium">金额</th>
                  <th className="text-left px-4 py-2 font-medium">备注</th>
                  <th className="text-left px-4 py-2 font-medium">分类（规则）</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => {
                  const ok = !it.rawLine && it.date && it.amount > 0;
                  const tone =
                    it.type === 'income' ? 'income' : it.type === 'expense' ? 'expense' : 'neutral';
                  const suggestedId = suggestions[i];
                  const effectiveId = i in overrides ? overrides[i] : suggestedId;
                  const effectiveCat =
                    effectiveId != null ? categoryMap.get(effectiveId) : undefined;
                  const showSuggestColumn = ok && (it.type === 'expense' || it.type === 'income');
                  return (
                    <tr
                      key={i}
                      className={clsx(
                        'border-t border-border dark:divide-border-dark',
                        !ok && 'opacity-50 line-through',
                      )}
                    >
                      <td className="px-4 py-2 text-text-muted">
                        {it.date ? dayjs(it.date).format('YYYY-MM-DD HH:mm') : it.rawLine ? '无法解析' : '—'}
                      </td>
                      <td className="px-4 py-2 truncate max-w-[200px]">{it.merchant || '—'}</td>
                      <td className="px-4 py-2">
                        <Badge tone={tone as 'income' | 'expense' | 'neutral'}>
                          {labelOf(it.type)}
                        </Badge>
                      </td>
                      <td
                        className={clsx(
                          'px-4 py-2 text-right tabular-nums',
                          it.type === 'income' ? 'text-income' : it.type === 'expense' ? 'text-expense' : '',
                        )}
                      >
                        {it.amount ? formatMoney(it.amount) : '—'}
                      </td>
                      <td className="px-4 py-2 truncate max-w-[200px]">{it.remark || '—'}</td>
                      <td className="px-4 py-2">
                        {showSuggestColumn ? (
                          effectiveCat ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <span className="inline-flex items-center gap-1 rounded-full bg-brand-soft text-brand px-2 py-0.5 text-xs">
                                {effectiveCat.icon && <span>{effectiveCat.icon}</span>}
                                <span>{effectiveCat.name}</span>
                              </span>
                              <button
                                type="button"
                                onClick={() => clearOverride(i)}
                                className="text-xs text-text-muted hover:text-expense"
                                title="清除分类"
                              >
                                ×
                              </button>
                            </div>
                          ) : suggestedId != null ? (
                            <button
                              type="button"
                              onClick={() => acceptSuggestion(i)}
                              className="inline-flex items-center gap-1 rounded-full border border-border dark:border-border-dark px-2 py-0.5 text-xs text-text-muted hover:text-text dark:hover:text-text-dark"
                              title="应用规则建议"
                            >
                              <IconWand size={12} />
                              应用建议
                            </button>
                          ) : (
                            <CategoryPicker
                              categories={categories ?? []}
                              value={undefined}
                              onChange={(v) => overrideCategory(i, v)}
                            />
                          )
                        ) : (
                          <span className="text-text-muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

/* ────────── 单元格内的小型分类选择器 ────────── */
function CategoryPicker({
  categories,
  value,
  onChange,
}: {
  categories: Category[];
  value: number | undefined;
  onChange: (v: number | undefined) => void;
}) {
  // 仅展示支出/收入两类分组
  const opts = useMemo(() => {
    const groups = new Map<string, Category[]>();
    for (const c of categories) {
      const arr = groups.get(c.group) ?? [];
      arr.push(c);
      groups.set(c.group, arr);
    }
    const list: Array<{ label: string; value: string }> = [];
    for (const [g, cats] of groups.entries()) {
      list.push({ label: `— ${g} —`, value: `_${g}` });
      for (const c of cats) {
        list.push({
          label: `${c.icon ? `${c.icon} ` : ''}${c.name}`,
          value: String(c.id),
        });
      }
    }
    return list;
  }, [categories]);

  return (
    <Select
      placeholder="选择分类"
      value={value === undefined ? '' : String(value)}
      options={opts}
      onChange={(e) =>
        onChange(e.target.value === '' ? undefined : Number(e.target.value))
      }
    />
  );
}

/* -------- 历史面板 -------- */

function HistoryPanel() {
  // 键不存在时服务端返回 404，useApi 会置 error 且 data 保持 null → 视为暂无记录
  const { data: kv } = useApi<{ key: string; value: ImportBatch[] }>(IMPORT_HISTORY_URL);
  const batches = kv?.value ?? [];

  if (batches.length === 0) {
    return (
      <div className="card">
        <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
          <IconCloudDownload size={36} className="text-text-muted mb-3" />
          <div className="text-base font-medium">暂无导入记录</div>
          <div className="mt-2 text-sm text-text-muted">
            导入账单成功后会在此显示历史记录
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="card !p-0 divide-y divide-border dark:divide-border-dark">
      {batches.map((b) => {
        const p = PLATFORMS.find((x) => x.id === b.platform);
        return (
          <div key={b.id} className="px-4 py-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{p?.name ?? b.platform} · {b.fileName}</div>
              <div className="text-xs text-text-muted mt-0.5">
                {dayjs(b.at).format('YYYY-MM-DD HH:mm')} · 共 {b.total} 条，导入 {b.imported} 条
              </div>
            </div>
            <Badge tone={b.imported === b.total ? 'income' : 'neutral'}>
              {b.imported === b.total ? '成功' : '部分成功'}
            </Badge>
          </div>
        );
      })}
    </div>
  );
}

function Card({ title, children, flush }: { title: React.ReactNode; children: React.ReactNode; flush?: boolean }) {
  return (
    <div className={clsx('card', !flush && 'p-6')}>
      <div className="mb-4 flex items-center justify-between">
        <div className="text-base font-medium text-text dark:text-text-dark">{title}</div>
      </div>
      {children}
    </div>
  );
}

function labelOf(t: string) {
  switch (t) {
    case 'expense':
      return '支出';
    case 'income':
      return '收入';
    case 'transfer':
      return '转账';
    case 'excluded':
      return '不计收支';
    default:
      return '其他';
  }
}

export default TransactionImportView;
