/**
 * 报表详情页 /report/detail/:id
 *
 * 根据报表的 template 字段分发到四个不同的渲染器：
 *   - monthly         近 12 月收入 / 支出分组柱状图（recharts BarChart）
 *   - yearly          当年收支 / 结余汇总卡 + 月度趋势折线（recharts LineChart）
 *   - distribution    按账户环形图 + 明细表
 *   - budget          占位（"预算功能尚未开启"）
 *
 * 所有数据均来自 db.accounts / db.transactions 的 useLiveQuery，实时计算。
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
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
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
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
        <div className="p-8 text-sm text-text-muted">加载中…</div>
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
        <div className="p-8 text-sm text-text-muted">
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

      <div className="p-8 max-w-[1200px] space-y-6">
        {report.description && (
          <Card>
            <div className="text-sm whitespace-pre-wrap text-text-muted">
              {report.description}
            </div>
          </Card>
        )}

        <TemplateRenderer templateKey={getTemplateKey(report)} />
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

/* ───────────────────── 模板分发 ───────────────────── */

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

/* ─────────────────── 预算执行（占位） ─────────────────── */

function BudgetTemplate() {
  return (
    <Card>
      <div className="py-8 flex flex-col items-center justify-center text-center">
        <div className="w-16 h-16 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center text-text-muted mb-4">
          <IconCircleDashed size={28} />
        </div>
        <div className="text-base font-medium">预算功能尚未开启</div>
        <div className="text-sm text-text-muted mt-2">
          预算模块正在规划中，敬请期待。
        </div>
      </div>
    </Card>
  );
}
