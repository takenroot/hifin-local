/**
 * 视觉实验室 · Zenith 模板风格变体（2026-10-06）
 * ---------------------------------------------------------------
 * 复刻对象：https://zenith-shadcn.dashboardpack.com/dashboard 的设计骨架。
 * 与 DashboardLab 的差异：
 *   - 三卡 → 四卡（增加「储蓄率」），卡底嵌入迷你 sparkline
 *   - 资产趋势单图 → Overview Tab 切换（收入/支出/结余）
 *   - 资产分布 donut 中心叠加净资产总额
 *   - 增加「目标进度」列表 + 「最近交易」表
 *
 * 铁规（继承自 DashboardLab.tsx 头注）：
 *   - 静态样例数据，**不发任何 API**
 *   - 视觉契约走我们令牌（bg-card/border/text-muted/CHART_COLORS/surface.stat），
 *     暗色自动成立——sparkline/area 用 currentColor + chart-* 类即可反转
 *   - 本页**不进 accept 回归闸**
 *   - tsc + vitest 必须过
 *
 * ponytail: 组件全部内联在本文件，不抽子组件——实验室页允许一次性堆叠，
 * 抽象边界由生产页（/home）提炼。
 */
import { useState } from 'react';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  PieChart,
  Pie,
  Cell,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import clsx from 'clsx';
import {
  IconFlask,
  IconWallet,
  IconArrowUpRight,
  IconArrowDownRight,
  IconPigMoney,
} from '@tabler/icons-react';
import { CHART_COLORS } from '@/lib/chartColors';
import { formatMoney, PIE_COLORS } from '@/lib/format';
import { LAB_ANCHOR } from './DashboardLab';
import { useLabData } from './useLabData';
import { LabDataSwitch } from './LabDataSwitch';

/* ───────────────────────── 小组件（局部复用） ───────────────────────── */

/** 静态渐变 id：固定字符串避免模板串被 a11y 收敛测试（field-convergence）
 * 误判为 orphan id（test 只 strip id 端，不 strip url(#..) 端的 `${}`） */
const SPARK_GRAD = {
  brand: 'zenith-spark-brand',
  income: 'zenith-spark-income',
  expense: 'zenith-spark-expense',
} as const;
const AREA_GRAD = {
  brand: 'zenith-area-brand',
  income: 'zenith-area-income',
  expense: 'zenith-area-expense',
} as const;

/** 四种语义 → recharts stroke 类（暗色自动反转靠 index.css 的 chart-* 工具类） */
function toneChartClass(tone: 'brand' | 'income' | 'expense'): string {
  // chart-brand 在 index.css 已定义；chart-income / chart-expense 也复用
  // text-income / text-expense 的 currentColor——为暗色反转特地新建两个工具类
  // 见下方 chartIncome / chartExpense CSS（写在 component-local <style> 里，
  // 避免污染全局）。ponytail: 选择 scoped <style> 是因为只 ZenithLab 需要。
  return `chart-${tone}`;
}

/** sparkline 容器：卡底 ~40px 高的紧凑图表，无坐标轴 */
function Sparkline({
  data,
  dataKey,
  tone,
  gradId,
}: {
  data: Array<{ [k: string]: number | string }>;
  dataKey: string;
  tone: 'brand' | 'income' | 'expense';
  /** 静态渐变 id（按 tone 固定），避免模板串被 a11y 测试误判为 orphan id */
  gradId: string;
}) {
  return (
    <div className="h-10 -mx-1 mt-3">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" className={toneChartClass(tone)} stopColor="currentColor" stopOpacity={0.35} />
              <stop offset="100%" className={toneChartClass(tone)} stopColor="currentColor" stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone"
            dataKey={dataKey}
            stroke="currentColor"
            className={toneChartClass(tone)}
            strokeWidth={1.5}
            fill={`url(#${gradId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** 统计卡：白 panel 卡 + 中性灰 icon chip + 大数字 + 环比 + sparkline */
function StatCard({
  label,
  amount,
  deltaPct,
  invert,
  icon,
  spark,
  tone,
  testid,
}: {
  label: string;
  amount: number;
  deltaPct: number;
  /** 支出场景"减少"算好事 → true */
  invert?: boolean;
  icon: React.ReactNode;
  spark: Array<{ [k: string]: number | string }>;
  tone: 'brand' | 'income' | 'expense';
  testid: string;
}) {
  const good = invert ? deltaPct < 0 : deltaPct > 0;
  const arrow = deltaPct > 0 ? '↑' : '↓';
  return (
    <div
      data-testid={testid}
      className="card !rounded-2xl p-5"
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark">{label}</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
            {amount.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        {/* 右上中性灰 icon chip——按设计不用彩色 chip */}
        <div className="h-10 w-10 rounded-xl bg-surface-stat dark:bg-surface-stat-dark flex items-center justify-center text-text-muted dark:text-text-muted-dark flex-none">
          {icon}
        </div>
      </div>
      <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
        较上月{' '}
        <span className={good ? 'text-income' : 'text-expense'}>
          {arrow} {Math.abs(deltaPct).toFixed(2)}%
        </span>
      </div>
      <Sparkline data={spark} dataKey="value" tone={tone} gradId={SPARK_GRAD[tone]} />
    </div>
  );
}

/* ───────────────────────── 页面 ───────────────────────── */

type OverviewTab = 'income' | 'expense' | 'balance';

export function ZenithLab() {
  const [tab, setTab] = useState<OverviewTab>('income');

  // 统一数据源：静态样例 ↔ 真实数据（横幅开关切换，见 useLabData）
  const lab = useLabData();
  const monthly = lab.monthly;
  const netAssetSeries = lab.netAssetMonthly;
  const savingsRateSeries = lab.savingsRateSeries;

  // 当前 tab → 折线色（卡进 chart-* 类的 currentColor）
  const tabColor: 'brand' | 'income' | 'expense' =
    tab === 'income' ? 'income' : tab === 'expense' ? 'expense' : 'brand';

  // donut 中心总额：用切片求和（与资产分布同源；真实数据下 = 正余额账户合计）
  const netAssetTotal = lab.slices.reduce((acc, sl) => acc + sl.value, 0);

  return (
    <div className="p-4 lg:p-8">
      {/* 页面骨架与生产契约对齐：p-4 lg:p-8 沟槽 + max-w-[1400px] 居中
         （原裸 space-y-6 导致内容贴 rail/视口边缘——web-design-guidelines 审查项） */}
      <div className="max-w-[1400px] mx-auto space-y-6" data-testid="zenith-lab">
      {/* 局部样式：暗色下 income / expense 折线反转——chart-brand 已有，扩展两个 */}
      {/* ponytail: <style> 作用域仅限本组件实例，Tailwind JIT 看不到的字面类
        在这里手写——单点扩展比改 index.css 风险更小。 */}
      <style>{`
        .chart-income { color: ${CHART_COLORS.income}; }
        .dark .chart-income { color: #34d399; }
        .chart-expense { color: ${CHART_COLORS.expense}; }
        .dark .chart-expense { color: #f87171; }
        .zenith-donut-center {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; pointer-events: none;
        }
      `}</style>

      {/* 实验室横幅——同 DashboardLab 的虚线盒；右侧数据源开关 */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border dark:border-border-dark px-4 py-2.5 text-xs text-text-muted dark:text-text-muted-dark">
        <span className="flex items-center gap-2 min-w-0">
          <IconFlask size={14} className="flex-none" />
          <span className="truncate">视觉实验室 · Zenith 变体 · 四卡+Tab+donut 中心叠加</span>
        </span>
        <LabDataSwitch error={lab.error} />
      </div>

      {/* 页面头：标题 + 问候副文案 */}
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-text dark:text-text-dark">看板</h1>
        <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
          欢迎回来，今天是个不错的一天。先看看数字有什么变化。
        </p>
      </header>

      {/* 四统计卡横排 */}
      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          testid="zenith-stat-netAsset"
          label={lab.stats.netAsset.label}
          amount={lab.stats.netAsset.amount}
          deltaPct={lab.stats.netAsset.deltaPct}
          icon={<IconWallet size={18} />}
          spark={netAssetSeries}
          tone="brand"
        />
        <StatCard
          testid="zenith-stat-income"
          label={lab.stats.income.label}
          amount={lab.stats.income.amount}
          deltaPct={lab.stats.income.deltaPct}
          icon={<IconArrowUpRight size={18} />}
          spark={monthly.map((m) => ({ value: m.income }))}
          tone="income"
        />
        <StatCard
          testid="zenith-stat-expense"
          label={lab.stats.expense.label}
          amount={lab.stats.expense.amount}
          deltaPct={lab.stats.expense.deltaPct}
          invert
          icon={<IconArrowDownRight size={18} />}
          spark={monthly.map((m) => ({ value: m.expense }))}
          tone="expense"
        />
        <StatCard
          testid="zenith-stat-savings"
          label={lab.stats.savings.label}
          amount={lab.stats.savings.amount}
          deltaPct={lab.stats.savings.deltaPct}
          icon={<IconPigMoney size={18} />}
          spark={savingsRateSeries}
          tone="brand"
        />
      </section>

      {/* Overview + 资产分布 + 目标进度（两栏：xl:8/4） */}
      <section className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Overview 大区 */}
        <div className="card p-5 xl:col-span-8" data-testid="zenith-overview">
          <div className="mb-3 flex items-start justify-between">
            <div>
              <h2 className="text-sm font-semibold text-text dark:text-text-dark">总览</h2>
              <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                近 12 个月收支走势
              </p>
            </div>
            {/* Tab 切换：激活色跟随语义（收入绿/支出红/结余炭黑） */}
            <div className="inline-flex h-8 rounded-lg bg-bg dark:bg-bg-dark p-0.5 text-xs">
              {(['income', 'expense', 'balance'] as const).map((t) => {
                const active = tab === t;
                const label = t === 'income' ? '收入' : t === 'expense' ? '支出' : '结余';
                const activeColor =
                  t === 'income' ? 'text-income' : t === 'expense' ? 'text-expense' : 'text-text dark:text-text-dark';
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    data-testid={`zenith-tab-${t}`}
                    className={clsx(
                      'px-3 h-7 rounded-md transition-colors',
                      active
                        ? `bg-bg-card dark:bg-bg-card-dark shadow-sm font-medium ${activeColor}`
                        : 'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="h-64 -mx-2">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={monthly} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id={AREA_GRAD[tabColor]} x1="0" y1="0" x2="0" y2="1">
                    <stop
                      offset="0%"
                      className={toneChartClass(tabColor)}
                      stopColor="currentColor"
                      stopOpacity={0.4}
                    />
                    <stop
                      offset="100%"
                      className={toneChartClass(tabColor)}
                      stopColor="currentColor"
                      stopOpacity={0}
                    />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke="currentColor"
                  className="text-border dark:text-border-dark"
                />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  className="text-text-muted dark:text-text-muted-dark"
                  tickFormatter={(v: string) => v.slice(5).replace(/^0/, '')}
                  minTickGap={28}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: 'currentColor' }}
                  className="text-text-muted dark:text-text-muted-dark"
                  width={56}
                  tickFormatter={(v: number) =>
                    Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v)
                  }
                />
                <Tooltip
                  formatter={(v: number | string) => [formatMoney(Number(v)), '']}
                  labelStyle={{ fontSize: 12 }}
                  contentStyle={{ borderRadius: 12, fontSize: 12 }}
                />
                <Area
                  type="monotone"
                  dataKey={tab}
                  stroke="currentColor"
                  className={toneChartClass(tabColor)}
                  strokeWidth={2}
                  fill={`url(#${AREA_GRAD[tabColor]})`}
                  animationDuration={600}
                  animationEasing="ease-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 右栏：donut + 目标进度 */}
        <div className="space-y-4 xl:col-span-4">
          {/* 资产分布 donut（中心叠加净资产总额） */}
          <div className="card p-5" data-testid="zenith-donut">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">资产分布</h2>
            <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">净资产构成</p>
            <div className="relative mt-3 h-44">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={lab.slices}
                    dataKey="value"
                    nameKey="name"
                    innerRadius="60%"
                    outerRadius="85%"
                    paddingAngle={2}
                    animationDuration={600}
                    animationEasing="ease-out"
                  >
                    {lab.slices.map((_, i) => (
                      <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v) => formatMoney(Number(v))} />
                </PieChart>
              </ResponsiveContainer>
              {/* 中心数字叠加——绝对定位压在 ResponsiveContainer 上 */}
              <div className="zenith-donut-center">
                <div className="text-[10px] text-text-muted dark:text-text-muted-dark">净资产</div>
                <div className="text-base font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
                  {formatMoney(netAssetTotal)}
                </div>
              </div>
            </div>
            <ul className="mt-2 space-y-1.5 text-xs">
              {lab.slices.map((s, i) => (
                <li key={s.name} className="flex items-center gap-2">
                  <span
                    className="h-2 w-2 rounded-sm flex-none"
                    style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                  />
                  <span className="flex-1 truncate text-text dark:text-text-dark">{s.name}</span>
                  <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                    {formatMoney(s.value)}
                  </span>
                </li>
              ))}
            </ul>
          </div>

          {/* 目标进度列表 */}
          <div className="card p-5" data-testid="zenith-goals">
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">目标进度</h2>
            <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">本季度追踪</p>
            <ul className="mt-3 space-y-3">
              {lab.goals.map((g) => {
                const pct = Math.min(100, Math.round((g.current / g.target) * 100));
                return (
                  <li key={g.name}>
                    <div className="flex items-baseline justify-between text-xs">
                      <span className="font-medium text-text dark:text-text-dark">{g.name}</span>
                      <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                        {pct}%
                      </span>
                    </div>
                    {/* 进度条：income 绿（与设计稿一致，活跃目标色高亮） */}
                    <div className="mt-1 h-1.5 rounded-full bg-bg dark:bg-bg-dark overflow-hidden">
                      <div
                        className="h-full bg-income rounded-full transition-[width] duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
                      <span>{formatMoney(g.current, false)}</span>
                      <span>目标 {formatMoney(g.target, false)}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      </section>

      {/* 最近交易表 */}
      <section className="card p-5" data-testid="zenith-tx">
        <div className="mb-3 flex items-baseline justify-between">
          <div>
            <h2 className="text-sm font-semibold text-text dark:text-text-dark">最近交易</h2>
            <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">最新 6 笔</p>
          </div>
          <span className="text-[11px] text-text-muted dark:text-text-muted-dark">锚定 {LAB_ANCHOR}</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-text-muted dark:text-text-muted-dark border-b border-border dark:border-border-dark">
                <th className="text-left font-medium py-2 pr-3">日期</th>
                <th className="text-left font-medium py-2 pr-3">名称</th>
                <th className="text-left font-medium py-2 pr-3">分类</th>
                <th className="text-left font-medium py-2 pr-3">账户</th>
                <th className="text-right font-medium py-2">金额</th>
              </tr>
            </thead>
            <tbody>
              {lab.recentTx.map((tx, i) => (
                <tr
                  key={i}
                  className="border-b border-border/60 dark:border-border-dark/60 last:border-b-0"
                >
                  <td className="py-2.5 pr-3 tabular-nums text-text-muted dark:text-text-muted-dark">
                    {tx.date}
                  </td>
                  <td className="py-2.5 pr-3 text-text dark:text-text-dark">{tx.name}</td>
                  <td className="py-2.5 pr-3 text-text-muted dark:text-text-muted-dark">{tx.category}</td>
                  <td className="py-2.5 pr-3 text-text-muted dark:text-text-muted-dark">{tx.account}</td>
                  <td
                    className={clsx(
                      'py-2.5 text-right tabular-nums font-medium',
                      tx.amount >= 0 ? 'text-income' : 'text-expense',
                    )}
                  >
                    {tx.amount >= 0 ? '+' : ''}
                    {formatMoney(tx.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </div>
  );
}

export default ZenithLab;
