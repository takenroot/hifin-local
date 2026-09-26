/**
 * 报表详情页 /report/detail/:id
 *
 * 渲染策略：
 *   - 若 Report.config 存在，按 config.range 过滤交易并按 config.components 顺序渲染组件。
 *   - 否则按 Report.template 字段分发到四个老模板渲染器（向后兼容）。
 *
 * 数据均来自 db.accounts / db.transactions / db.categories 的 useLiveQuery，实时计算。
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import {
  IconArrowLeft,
  IconChartBar,
  IconPencil,
  IconTrash,
  IconEye,
  IconShare,
  IconCircleDashed,
} from '@tabler/icons-react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
} from '@/components/ui';
import { db, type Report } from '@/db';
import {
  calcNetAsset,
  distributionByAccount,
  distributionByType,
  monthly12,
  yearlySummary,
  type DistributionDatum,
} from './calculations';
import { formatAxis, formatMoney } from './format';
import { getTemplateKey, templateMeta } from './metadata';
import {
  REPORT_RANGE_OPTIONS,
  categoryRankByRange,
  monthlyByRange,
  parseReportConfig,
  type ReportComponentKey,
  type ReportConfig,
} from './config';
import { useState } from 'react';
import { ReportFormModal } from './ReportFormModal';
import { DeleteConfirmModal } from './DeleteConfirmModal';
import dayjs from 'dayjs';

const PIE_COLORS = [
  '#10b981',
  '#6366f1',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#a3e635',
  '#f43f5e',
];

export default function ReportDetail() {
  const params = useParams<{ id: string }>();
  const navigate = useNavigate();
  const reportId = Number(params.id);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const report = useLiveQuery<Report | null | undefined>(
    async () => {
      if (!Number.isFinite(reportId)) return null;
      const r = await db.reports.get(reportId);
      return r ?? null;
    },
    [reportId],
  );

  if (report === undefined) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="报表详情"
          icon={<IconChartBar size={18} />}
          actions={
            <Button
              variant="ghost"
              icon={<IconArrowLeft size={16} />}
              onClick={() => navigate('/report/list')}
            >
              返回列表
            </Button>
          }
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted">加载中…</div>
      </div>
    );
  }

  if (report === null) {
    return (
      <div className="min-h-full bg-bg dark:bg-bg-dark">
        <PageHeader
          title="报表不存在"
          icon={<IconChartBar size={18} />}
          actions={
            <Button
              variant="ghost"
              icon={<IconArrowLeft size={16} />}
              onClick={() => navigate('/report/list')}
            >
              返回列表
            </Button>
          }
        />
        <div className="p-4 lg:p-8 text-sm text-text-muted">
          该报表已被删除或不存在。
        </div>
      </div>
    );
  }

  async function handleDeleteConfirm() {
    if (!report?.id) return;
    await db.reports.delete(report.id);
    setDeleteOpen(false);
    navigate('/report/list');
  }

  const meta = templateMeta(getTemplateKey(report));
  const hasConfig = !!report.config;
  const config = hasConfig ? parseReportConfig(report.config) : null;
  const rangeLabel = config
    ? REPORT_RANGE_OPTIONS.find((o) => o.key === config.range)?.label ?? ''
    : '';

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title={report.name}
        description={meta.label}
        icon={
          <span
            className="w-7 h-7 rounded-lg flex items-center justify-center"
            style={{ background: `${meta.tone}22`, color: meta.tone }}
          >
            <span className="text-base">{report.icon ?? meta.icon}</span>
          </span>
        }
        actions={
          <>
            <div className="flex items-center gap-2 text-text-muted">
              <IconEye size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
              <IconShare size={18} className="cursor-pointer hover:text-text dark:hover:text-text-dark" />
            </div>
            <Button
              variant="secondary"
              icon={<IconPencil size={16} />}
              onClick={() => setEditOpen(true)}
            >
              编辑
            </Button>
            <Button
              variant="danger"
              icon={<IconTrash size={16} />}
              onClick={() => setDeleteOpen(true)}
            >
              删除
            </Button>
          </>
        }
      />

      <div className="p-4 lg:p-8 max-w-[1200px] space-y-6">
        {report.description && (
          <Card>
            <div className="text-sm whitespace-pre-wrap text-text-muted">
              {report.description}
            </div>
          </Card>
        )}

        {hasConfig && config ? (
          <ConfigRenderer config={config} rangeLabel={rangeLabel} />
        ) : (
          <TemplateRenderer templateKey={getTemplateKey(report)} />
        )}
      </div>

      <ReportFormModal
        open={editOpen}
        onClose={() => setEditOpen(false)}
        report={report}
      />
      <DeleteConfirmModal
        open={deleteOpen}
        title="删除报表"
        message={
          <>
            确定要删除报表「
            <span className="font-medium">{report.name}</span>
            」吗？此操作不可撤销。
          </>
        }
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDeleteConfirm}
      />
    </div>
  );
}

/* ───────────────────── 自定义配置渲染器 ───────────────────── */

function ConfigRenderer({
  config,
  rangeLabel,
}: {
  config: ReportConfig;
  rangeLabel: string;
}) {
  const transactions = useLiveQuery(
    () => db.transactions.toArray(),
    [],
  ) ?? [];
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 text-xs text-text-muted">
        <span className="inline-flex items-center px-2 h-5 rounded-md bg-bg dark:bg-bg-card-dark">
          数据范围 · {rangeLabel}
        </span>
        <span>
          已选 {config.components.length} 个组件
        </span>
      </div>

      {config.components.map((key) => (
        <ConfigComponent
          key={key}
          componentKey={key}
          config={config}
          transactions={transactions}
          accounts={accounts}
          categories={categories}
        />
      ))}
    </div>
  );
}

function ConfigComponent({
  componentKey,
  config,
  transactions,
  accounts,
  categories,
}: {
  componentKey: ReportComponentKey;
  config: ReportConfig;
  transactions: Parameters<typeof monthlyByRange>[0];
  accounts: Parameters<typeof distributionByAccount>[0];
  categories: Array<{ id?: number; name: string; group: string }>;
}) {
  switch (componentKey) {
    case 'incomeExpenseBar':
      return <ConfigIncomeExpenseBar transactions={transactions} rangeKey={config.range} />;
    case 'assetPie':
      return <ConfigAssetPie accounts={accounts} />;
    case 'trendArea':
      return <ConfigTrendArea transactions={transactions} rangeKey={config.range} />;
    case 'categoryRank':
      return (
        <ConfigCategoryRank
          transactions={transactions}
          categories={categories}
          rangeKey={config.range}
        />
      );
    default:
      return null;
  }
}

function ConfigIncomeExpenseBar({
  transactions,
  rangeKey,
}: {
  transactions: Parameters<typeof monthlyByRange>[0];
  rangeKey: ReportConfig['range'];
}) {
  const data = useMemo(() => monthlyByRange(transactions, rangeKey), [transactions, rangeKey]);
  const hasData = data.some((d) => d.income > 0 || d.expense > 0);
  return (
    <Card title="收支柱状图">
      {hasData ? (
        <div className="h-72 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                className="text-border dark:text-border-dark"
                stroke="currentColor"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
                tickFormatter={(v: number) => formatAxis(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number | string, name: string) => [
                  formatMoney(Number(v)),
                  name === 'income' ? '收入' : '支出',
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(v) => (v === 'income' ? '收入' : '支出')}
              />
              <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState
          title="暂无数据"
          description="当前数据范围内没有收入或支出记录"
        />
      )}
    </Card>
  );
}

function ConfigAssetPie({
  accounts,
}: {
  accounts: Parameters<typeof distributionByAccount>[0];
}) {
  const [mode, setMode] = useState<'account' | 'type'>('account');
  const data: DistributionDatum[] = useMemo(
    () =>
      mode === 'account'
        ? distributionByAccount(accounts)
        : distributionByType(accounts),
    [mode, accounts],
  );
  const total = useMemo(() => data.reduce((s, x) => s + x.value, 0), [data]);
  const hasData = data.length > 0;
  return (
    <Card
      title="资产分布环图"
      extra={
        hasData && (
          <div className="flex items-center gap-1 p-1 bg-bg dark:bg-bg-card-dark rounded-xl text-xs">
            {(
              [
                { key: 'account', label: '按账户' },
                { key: 'type', label: '按类型' },
              ] as const
            ).map((it) => (
              <button
                key={it.key}
                type="button"
                onClick={() => setMode(it.key)}
                className={
                  mode === it.key
                    ? 'px-3 h-7 rounded-lg bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                    : 'px-3 h-7 rounded-lg text-text-muted hover:text-text dark:hover:text-text-dark'
                }
              >
                {it.label}
              </button>
            ))}
          </div>
        )
      }
    >
      {hasData ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                >
                  {data.map((_, i) => (
                    <Cell
                      key={i}
                      fill={PIE_COLORS[i % PIE_COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#fff',
                    border: '1px solid #e5e7eb',
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  formatter={(v: number | string) => formatMoney(Number(v))}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="space-y-2">
            {data.map((d, i) => (
              <div key={d.key} className="flex items-center gap-3 text-sm">
                <span
                  className="w-3 h-3 rounded-sm flex-none"
                  style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <span className="flex-1 truncate">{d.name}</span>
                <span className="text-text-muted tabular-nums">
                  {d.pct.toFixed(1)}%
                </span>
                <span className="font-medium tabular-nums w-28 text-right">
                  {formatMoney(d.value, false)}
                </span>
              </div>
            ))}
            <div className="mt-3 pt-3 border-t border-border dark:border-border-dark flex items-center justify-between text-sm">
              <span className="text-text-muted">合计</span>
              <span className="font-medium tabular-nums text-income">
                {formatMoney(total, false)}
              </span>
            </div>
          </div>
        </div>
      ) : (
        <EmptyState
          title="暂无数据"
          description="添加账户并设置余额后，这里会显示资产占比"
        />
      )}
    </Card>
  );
}

function ConfigTrendArea({
  transactions,
  rangeKey,
}: {
  transactions: Parameters<typeof monthlyByRange>[0];
  rangeKey: ReportConfig['range'];
}) {
  const data = useMemo(() => monthlyByRange(transactions, rangeKey), [transactions, rangeKey]);
  const hasData = data.some((d) => d.net !== 0);
  return (
    <Card title="趋势面积图">
      {hasData ? (
        <div className="h-72 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="trendNet" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.5} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.05} />
                </linearGradient>
              </defs>
              <CartesianGrid
                strokeDasharray="3 3"
                className="text-border dark:text-border-dark"
                stroke="currentColor"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
                tickFormatter={(v: number) => formatAxis(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number | string) => [formatMoney(Number(v)), '结余']}
              />
              <Area
                type="monotone"
                dataKey="net"
                stroke="#6366f1"
                strokeWidth={2}
                fill="url(#trendNet)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState
          title="暂无数据"
          description="当前数据范围内没有结余可显示"
        />
      )}
    </Card>
  );
}

function ConfigCategoryRank({
  transactions,
  categories,
  rangeKey,
}: {
  transactions: Parameters<typeof monthlyByRange>[0];
  categories: Array<{ id?: number; name: string; group: string }>;
  rangeKey: ReportConfig['range'];
}) {
  const rows = useMemo(
    () => categoryRankByRange(transactions, categories, rangeKey),
    [transactions, categories, rangeKey],
  );
  const hasData = rows.length > 0;
  const total = rows.reduce((s, r) => s + r.amount, 0);
  return (
    <Card title="分类排行表">
      {hasData ? (
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-border dark:border-border-dark">
                <th className="px-2 py-2 font-normal">排名</th>
                <th className="px-2 py-2 font-normal">分类</th>
                <th className="px-2 py-2 font-normal text-right">金额</th>
                <th className="px-2 py-2 font-normal">占比</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, idx) => (
                <tr
                  key={r.categoryId}
                  className="border-b border-border dark:border-border-dark last:border-b-0"
                >
                  <td className="px-2 py-3 text-text-muted tabular-nums w-12">
                    {idx + 1}
                  </td>
                  <td className="px-2 py-3 font-medium">{r.name}</td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatMoney(r.amount, false)}
                  </td>
                  <td className="px-2 py-3 w-48">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-bg dark:bg-bg-card-dark overflow-hidden">
                        <div
                          className="h-full rounded-full bg-expense"
                          style={{
                            width: `${Math.max(0, Math.min(100, r.pct))}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs tabular-nums w-10 text-right text-text-muted">
                        {r.pct.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border dark:border-border-dark">
                <td className="px-2 py-3 text-text-muted">合计</td>
                <td className="px-2 py-3" />
                <td className="px-2 py-3 text-right font-medium tabular-nums">
                  {formatMoney(total, false)}
                </td>
                <td className="px-2 py-3" />
              </tr>
            </tfoot>
          </table>
        </div>
      ) : (
        <EmptyState
          title="暂无数据"
          description="当前数据范围内没有支出记录"
        />
      )}
    </Card>
  );
}

/* ───────────────────── 模板分发（老数据 / 无 config 时使用） ───────────────────── */

function TemplateRenderer({ templateKey }: { templateKey: string }) {
  switch (templateKey) {
    case 'monthly':
      return <MonthlyTemplate />;
    case 'yearly':
      return <YearlyTemplate />;
    case 'distribution':
      return <DistributionTemplate />;
    case 'budget':
      return <BudgetTemplate />;
    default:
      return <MonthlyTemplate />;
  }
}

/* ─────────────────── 月度收支 ─────────────────── */

function MonthlyTemplate() {
  const transactions = useLiveQuery(
    () => db.transactions.toArray(),
    [],
  ) ?? [];

  const data = useMemo(() => monthly12(transactions), [transactions]);
  const hasData = data.some((d) => d.income > 0 || d.expense > 0);

  return (
    <Card title="近 12 月收支">
      {hasData ? (
        <div className="h-72 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 10, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                className="text-border dark:text-border-dark"
                stroke="currentColor"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
                tickFormatter={(v: number) => formatAxis(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number | string, name: string) => [
                  formatMoney(Number(v)),
                  name === 'income' ? '收入' : '支出',
                ]}
                labelFormatter={(label: string) => `${label}`}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(v) => (v === 'income' ? '收入' : '支出')}
              />
              <Bar dataKey="income" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="expense" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <EmptyState
          title="暂无数据"
          description="添加交易后，这里会显示近 12 月的收入和支出趋势"
        />
      )}
    </Card>
  );
}

/* ─────────────────── 年度总结 ─────────────────── */

function YearlyTemplate() {
  const transactions = useLiveQuery(
    () => db.transactions.toArray(),
    [],
  ) ?? [];
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) ?? [];

  const summary = useMemo(
    () => yearlySummary(transactions),
    [transactions],
  );
  const trend = useMemo(() => monthly12(transactions), [transactions]);
  const netAsset = useMemo(() => calcNetAsset(accounts), [accounts]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <SummaryCard
          label="本年支出"
          tone="expense"
          amount={summary.expense}
          icon="📤"
        />
        <SummaryCard
          label="本年收入"
          tone="income"
          amount={summary.income}
          icon="📥"
        />
        <SummaryCard
          label="本年结余"
          tone={summary.net >= 0 ? 'income' : 'expense'}
          amount={summary.net}
          icon="💰"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="!p-5">
          <div className="text-xs text-text-muted">当年交易笔数</div>
          <div className="mt-2 text-2xl font-medium tabular-nums text-text dark:text-text-dark">
            {summary.transactionCount}
          </div>
        </Card>
        <Card className="!p-5">
          <div className="text-xs text-text-muted">当前净资产</div>
          <div className="mt-2 text-2xl font-medium text-income tabular-nums">
            {formatMoney(netAsset, false)}
          </div>
        </Card>
        <Card className="!p-5">
          <div className="text-xs text-text-muted">年份</div>
          <div className="mt-2 text-2xl font-medium tabular-nums">
            {summary.year}
          </div>
        </Card>
      </div>

      <Card title={`${summary.year} 年月度趋势`}>
        <div className="h-72 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={trend}
              margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="text-border dark:text-border-dark"
                stroke="currentColor"
              />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
                tickFormatter={(v: number) => formatAxis(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number | string, name: string) => [
                  formatMoney(Number(v)),
                  name === 'income'
                    ? '收入'
                    : name === 'expense'
                      ? '支出'
                      : '结余',
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(v) =>
                  v === 'income'
                    ? '收入'
                    : v === 'expense'
                      ? '支出'
                      : '结余'
                }
              />
              <Line
                type="monotone"
                dataKey="income"
                stroke="#10b981"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="expense"
                stroke="#ef4444"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="net"
                stroke="#6366f1"
                strokeWidth={2}
                strokeDasharray="4 4"
                dot={{ r: 3 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  tone,
  amount,
  icon,
}: {
  label: string;
  tone: 'income' | 'expense';
  amount: number;
  icon: string;
}) {
  return (
    <Card className="!p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <span>{icon}</span>
          <span>{label}</span>
        </div>
        <Badge tone={tone}>{tone === 'income' ? '正向' : '负向'}</Badge>
      </div>
      <div
        className={
          tone === 'income'
            ? 'mt-3 text-2xl font-medium text-income tabular-nums'
            : 'mt-3 text-2xl font-medium text-expense tabular-nums'
        }
      >
        {formatMoney(amount)}
      </div>
    </Card>
  );
}

/* ─────────────────── 资产分布 ─────────────────── */

function DistributionTemplate() {
  const accounts = useLiveQuery(() => db.accounts.toArray(), []) ?? [];
  const [mode, setMode] = useState<'account' | 'type'>('account');
  const data: DistributionDatum[] = useMemo(
    () => (mode === 'account' ? distributionByAccount(accounts) : distributionByType(accounts)),
    [mode, accounts],
  );
  const total = useMemo(
    () => data.reduce((s, x) => s + x.value, 0),
    [data],
  );
  const hasData = data.length > 0;

  // 把每天 24h 的"更新时间"显示在右上
  const updatedAt = useMemo(() => dayjs(), []);

  return (
    <div className="space-y-6">
      <Card
        title="资产分布"
        extra={
          hasData && (
            <div className="flex items-center gap-1 p-1 bg-bg dark:bg-bg-card-dark rounded-xl text-xs">
              {(
                [
                  { key: 'account', label: '按账户' },
                  { key: 'type', label: '按类型' },
                ] as const
              ).map((it) => (
                <button
                  key={it.key}
                  type="button"
                  onClick={() => setMode(it.key)}
                  className={
                    mode === it.key
                      ? 'px-3 h-7 rounded-lg bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                      : 'px-3 h-7 rounded-lg text-text-muted hover:text-text dark:hover:text-text-dark'
                  }
                >
                  {it.label}
                </button>
              ))}
            </div>
          )
        }
      >
        {hasData ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
            <div className="h-72">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={data}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                  >
                    {data.map((_, i) => (
                      <Cell
                        key={i}
                        fill={PIE_COLORS[i % PIE_COLORS.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#fff',
                      border: '1px solid #e5e7eb',
                      borderRadius: 12,
                      fontSize: 12,
                    }}
                    formatter={(v: number | string) => formatMoney(Number(v))}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="space-y-2">
              {data.map((d, i) => (
                <div
                  key={d.key}
                  className="flex items-center gap-3 text-sm"
                >
                  <span
                    className="w-3 h-3 rounded-sm flex-none"
                    style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                  <span className="flex-1 truncate">{d.name}</span>
                  <span className="text-text-muted tabular-nums">
                    {d.pct.toFixed(1)}%
                  </span>
                  <span className="font-medium tabular-nums w-28 text-right">
                    {formatMoney(d.value, false)}
                  </span>
                </div>
              ))}
              <div className="mt-3 pt-3 border-t border-border dark:border-border-dark flex items-center justify-between text-sm">
                <span className="text-text-muted">合计</span>
                <span className="font-medium tabular-nums text-income">
                  {formatMoney(total, false)}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            title="暂无数据"
            description="添加账户并设置余额后，这里会显示资产占比"
          />
        )}
        {hasData && (
          <div className="mt-4 text-xs text-text-muted">
            数据更新于 {updatedAt.format('YYYY-MM-DD HH:mm')}
          </div>
        )}
      </Card>
    </div>
  );
}

/* ─────────────────── 预算执行 ─────────────────── */

function BudgetTemplate() {
  const budgets = useLiveQuery(
    () => db.budgets.toArray(),
    [],
  ) ?? [];
  const categories = useLiveQuery(() => db.categories.toArray(), []) ?? [];
  const transactions = useLiveQuery(
    () => db.transactions.toArray(),
    [],
  ) ?? [];
  const navigate = useNavigate();

  const now = new Date();
  const monthRange = periodRangeOf('monthly', now);

  // 仅展示"当月生效"的预算：period==='monthly'，或 yearly（覆盖全年）
  const monthlyBudgets = budgets.filter((b) => b.period === 'monthly');
  const yearlyBudgets = budgets.filter((b) => b.period === 'yearly');

  type Row = {
    id: number;
    name: string;
    categoryLabel: string;
    budgetAmount: number;
    actual: number;
    pct: number;
    overspent: boolean;
    remaining: number;
  };

  const rows: Row[] = useMemo(() => {
    const catMap = new Map<number, string>();
    for (const c of categories) {
      if (c.id != null) catMap.set(c.id, `${c.group} · ${c.name}`);
    }

    const spentByKey = new Map<string, number>();
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      if (t.date < monthRange.from || t.date >= monthRange.to) continue;
      // 总预算：categoryId=undefined 累计全部 expense
      // 分类预算：仅匹配对应 categoryId
      for (const b of budgets) {
        if (b.categoryId != null && t.categoryId !== b.categoryId) continue;
        const k = `${b.id}`;
        spentByKey.set(k, (spentByKey.get(k) ?? 0) + t.amount);
      }
    }

    const list: Row[] = [];
    // monthly 优先
    for (const b of monthlyBudgets) {
      const actual = spentByKey.get(`${b.id}`) ?? 0;
      const budgetAmount = b.amount;
      const pct = budgetAmount > 0 ? (actual / budgetAmount) * 100 : 0;
      list.push({
        id: b.id!,
        name: b.name,
        categoryLabel: b.categoryId != null ? (catMap.get(b.categoryId) ?? '未知分类') : '总预算（全部支出）',
        budgetAmount,
        actual,
        pct,
        overspent: actual > budgetAmount && budgetAmount > 0,
        remaining: budgetAmount - actual,
      });
    }
    // 年度预算作为补充；用于"年度预算 vs 当月已花"展示
    for (const b of yearlyBudgets) {
      const actual = spentByKey.get(`${b.id}`) ?? 0;
      const budgetAmount = b.amount;
      const pct = budgetAmount > 0 ? (actual / budgetAmount) * 100 : 0;
      list.push({
        id: b.id!,
        name: b.name,
        categoryLabel: b.categoryId != null ? (catMap.get(b.categoryId) ?? '未知分类') : '总预算（全部支出）',
        budgetAmount,
        actual,
        pct,
        overspent: actual > budgetAmount && budgetAmount > 0,
        remaining: budgetAmount - actual,
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgets, categories, transactions]);

  if (rows.length === 0) {
    return (
      <Card>
        <div className="py-10 flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center text-text-muted mb-4">
            <IconCircleDashed size={28} />
          </div>
          <div className="text-base font-medium">请先在预算页创建预算</div>
          <div className="text-sm text-text-muted mt-2 max-w-sm">
            前往预算管理页创建月度或年度预算，这里会自动汇总当月预算与实际支出对比
          </div>
          <Button
            variant="primary"
            className="mt-5"
            icon={<IconCircleDashed size={16} />}
            onClick={() => navigate('/budget?create=1')}
          >
            去创建预算
          </Button>
        </div>
      </Card>
    );
  }

  const chartData = rows.map((r) => ({
    name: r.name,
    预算: r.budgetAmount,
    实际: r.actual,
  }));
  const totalBudget = rows.reduce((s, r) => s + r.budgetAmount, 0);
  const totalActual = rows.reduce((s, r) => s + r.actual, 0);
  const totalOverspent = totalActual > totalBudget && totalBudget > 0;

  return (
    <div className="space-y-6">
      {/* 汇总卡 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="!p-5">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-muted">当月预算合计</div>
          </div>
          <div className="mt-2 text-2xl font-medium tabular-nums text-text dark:text-text-dark">
            {formatMoney(totalBudget, false)}
          </div>
        </Card>
        <Card className="!p-5">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-muted">当月实际支出</div>
          </div>
          <div
            className={
              totalOverspent
                ? 'mt-2 text-2xl font-medium tabular-nums text-expense'
                : 'mt-2 text-2xl font-medium tabular-nums text-text dark:text-text-dark'
            }
          >
            {formatMoney(totalActual, false)}
          </div>
        </Card>
        <Card className="!p-5">
          <div className="flex items-center justify-between">
            <div className="text-xs text-text-muted">
              {totalOverspent ? '超支金额' : '剩余预算'}
            </div>
          </div>
          <div
            className={
              totalOverspent
                ? 'mt-2 text-2xl font-medium tabular-nums text-expense'
                : 'mt-2 text-2xl font-medium tabular-nums text-income'
            }
          >
            {formatMoney(Math.abs(totalBudget - totalActual), false)}
          </div>
        </Card>
      </div>

      {/* 柱状对比图 */}
      <Card title="预算 vs 实际（当月）">
        <div className="h-80 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
            >
              <CartesianGrid
                strokeDasharray="3 3"
                className="text-border dark:text-border-dark"
                stroke="currentColor"
              />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted"
                tickFormatter={(v: number) => formatAxis(v)}
                width={60}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #e5e7eb',
                  borderRadius: 12,
                  fontSize: 12,
                }}
                formatter={(v: number | string, name: string) => [
                  formatMoney(Number(v)),
                  name === '预算' ? '预算' : '实际',
                ]}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(v) => (v === '预算' ? '预算' : '实际')}
              />
              <Bar dataKey="预算" fill="#6366f1" radius={[4, 4, 0, 0]} />
              <Bar dataKey="实际" fill="#ef4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      {/* 明细表 */}
      <Card title="预算执行明细">
        <div className="overflow-x-auto -mx-2">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-text-muted border-b border-border dark:border-border-dark">
                <th className="px-2 py-2 font-normal">预算名称</th>
                <th className="px-2 py-2 font-normal">关联分类</th>
                <th className="px-2 py-2 font-normal text-right">预算金额</th>
                <th className="px-2 py-2 font-normal text-right">实际支出</th>
                <th className="px-2 py-2 font-normal">进度</th>
                <th className="px-2 py-2 font-normal text-right">
                  {totalOverspent ? '差额' : '剩余'}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-border dark:border-border-dark last:border-b-0"
                >
                  <td className="px-2 py-3 font-medium">{r.name}</td>
                  <td className="px-2 py-3 text-text-muted">{r.categoryLabel}</td>
                  <td className="px-2 py-3 text-right tabular-nums">
                    {formatMoney(r.budgetAmount, false)}
                  </td>
                  <td
                    className={clsx(
                      'px-2 py-3 text-right tabular-nums',
                      r.overspent ? 'text-expense' : 'text-text dark:text-text-dark',
                    )}
                  >
                    {formatMoney(r.actual, false)}
                  </td>
                  <td className="px-2 py-3 w-40">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-1.5 rounded-full bg-bg dark:bg-bg-card-dark overflow-hidden">
                        <div
                          className={clsx(
                            'h-full rounded-full',
                            r.overspent ? 'bg-expense' : 'bg-income',
                          )}
                          style={{
                            width: `${Math.max(0, Math.min(100, r.pct))}%`,
                          }}
                        />
                      </div>
                      <span
                        className={clsx(
                          'text-xs tabular-nums w-10 text-right',
                          r.overspent ? 'text-expense' : 'text-text-muted',
                        )}
                      >
                        {r.pct.toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td
                    className={clsx(
                      'px-2 py-3 text-right tabular-nums',
                      r.overspent ? 'text-expense' : 'text-income',
                    )}
                  >
                    {formatMoney(Math.abs(r.remaining), false)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* 当月时间范围 [from, to) */
function periodRangeOf(
  period: 'monthly' | 'yearly',
  at: Date,
): { from: number; to: number } {
  const y = at.getFullYear();
  const m = at.getMonth();
  if (period === 'monthly') {
    return {
      from: new Date(y, m, 1, 0, 0, 0, 0).getTime(),
      to: new Date(y, m + 1, 1, 0, 0, 0, 0).getTime(),
    };
  }
  return {
    from: new Date(y, 0, 1, 0, 0, 0, 0).getTime(),
    to: new Date(y + 1, 0, 1, 0, 0, 0, 0).getTime(),
  };
}