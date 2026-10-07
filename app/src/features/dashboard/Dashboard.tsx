/**
 * 看板 Dashboard（zenith 形态重写，2026-10-06）
 * ---------------------------------------------------------------
 * 设计骨架沿用视觉实验室 ZenithLab（/lab/zenith）：白 panel 卡 + 中性灰
 * icon chip + 大数字 + 环比 + 卡底 sparkline。数据层走真实 REST（按任务
 * 要求"默认就是真实数据"——lab 那种 mock/real 开关是实验室专属）。
 *
 * 布局：
 *   - xl:col-span-8：Overview（Tab 切换：收入/支出/结余/分类——前三个
 *     12 月面积图，分类 tab 沿用旧看板的统计饼图+排行+月份翻页）
 *   - xl:col-span-4：还款提醒（条件渲染）/ 资产分布 donut（中心叠加
 *     净资产）/ 目标进度 / 预算执行
 *   - 最近交易表（zenith 表格形态）
 *
 * 数据契约：
 *   - 7 路 useApi：accounts/transactions/goals/budgets/categories/
 *     kv/nickname/summary
 *   - 聚合口径在 lib/monthlyAgg.ts（与 /lab/legacy+zenith 共享一份纯函数）
 *
 * 历史保留：
 *   - 旧看板 1:1 存档在 features/lab/ClassicLab.tsx，路由 /lab/classic。
 *
 * ponytail: 组件全部内联在本文件，实验室页 vs 板板页视觉骨架对齐即可，
 * 抽象边界不在此处强求——重写首版优先"形状对、数字真"。
 */
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
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
  IconArrowDownRight,
  IconArrowUpRight,
  IconLayoutDashboard,
  IconPigMoney,
  IconWallet,
  IconEye,
  IconEyeClosed,
  IconAlertTriangle,
  IconChevronLeft,
  IconChevronRight,
  IconArrowRight,
} from '@tabler/icons-react';
import { CHART_COLORS } from '@/lib/chartColors';
import { formatMoney, PIE_COLORS } from '@/lib/format';
import {
  monthKeyOf,
  toMonthlyPoints,
  toNetAssetMonthlySeries,
  toSavingsRateSeries,
  toLabStats,
  toSlices,
  dateKeyOf,
  type TxRow,
  type AccountRow,
  type GoalRow,
  type SummaryRow,
} from '@/lib/monthlyAgg';
import { threePhaseEasing, CHART_ANIMATION_MS } from '@/lib/chartEasing';
import { DashboardInsightCard, buildInsightContext } from './InsightCard';
import type { Budget, Category, Goal, Account, Transaction } from '@/db';
import { useSpaceId } from '@/db';
import { useApi } from '@/hooks/useApi';
import { buildBudgetProgress } from './calculations';
import {
  greetingByHour,
  weekdayCn,
} from './format';
import { getWeatherSync, refreshWeather, wmoToText, type WeatherInfo } from './weather';

/* ───────────────────────── 静态 id（暗色反转靠 chart-* currentColor） ───────────────────────── */

const SPARK_GRAD = {
  brand: 'dash-spark-brand',
  income: 'dash-spark-income',
  expense: 'dash-spark-expense',
} as const;
const AREA_GRAD = {
  brand: 'dash-area-brand',
  income: 'dash-area-income',
  expense: 'dash-area-expense',
} as const;

function toneChartClass(tone: 'brand' | 'income' | 'expense'): string {
  // chart-brand 在 index.css；chart-income / chart-expense 由下方 <style> 注入
  return `chart-${tone}`;
}

/* ───────────────────────── 小组件 ───────────────────────── */

interface SparklineProps {
  data: Array<{ [k: string]: number | string }>;
  dataKey: string;
  tone: 'brand' | 'income' | 'expense';
  gradId: string;
}

/** 卡底 sparkline：紧凑、无坐标轴、走 currentColor + chart-* */
function Sparkline({ data, dataKey, tone, gradId }: SparklineProps) {
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

interface StatCardProps {
  label: string;
  amount: number;
  deltaPct: number;
  invert?: boolean;
  icon: React.ReactNode;
  spark: Array<{ [k: string]: number | string }>;
  tone: 'brand' | 'income' | 'expense';
  hide: boolean;
  testid?: string;
}

/**
 * 四统计卡（zenith 形态）：白 panel + 中性灰 icon chip + 大数字 + 环比 + sparkline。
 * 旧的 sample 卡（surface.stat 色块 / 圆角 3xl）已并入 /lab/classic 存档。
 */
export function StatCard({
  label,
  amount,
  deltaPct,
  invert,
  icon,
  spark,
  tone,
  hide,
  testid,
}: StatCardProps) {
  const good = invert ? deltaPct < 0 : deltaPct > 0;
  const arrow = deltaPct > 0 ? '↑' : deltaPct < 0 ? '↓' : '';
  return (
    <div
      data-testid={testid}
      className="card !rounded-2xl p-5"
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="text-xs text-text-muted dark:text-text-muted-dark">{label}</div>
          <div className="mt-1.5 text-2xl font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
            {hide ? '¥ ******' : formatMoney(amount)}
          </div>
        </div>
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

/* ───────────────────────── 隐藏金额持久化 ───────────────────────── */

function readHideAmounts(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('hifin:hideAmounts') === 'true';
  } catch {
    return false;
  }
}

function writeHideAmounts(v: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('hifin:hideAmounts', String(v));
  } catch {
    /* 隐私模式/配额耗尽静默 */
  }
}

/* ───────────────────────── 页面 ───────────────────────── */

type OverviewTab = 'income' | 'expense' | 'balance' | 'category';

export default function Dashboard() {
  // 顶栏眼睛
  const [hideAmounts, setHideAmounts] = useState<boolean>(() => readHideAmounts());
  // 持久化（effect 写内存，不打断首帧）
  useEffect(() => {
    writeHideAmounts(hideAmounts);
  }, [hideAmounts]);

  // Overview tab（默认 income tab；分类 tab 是次级入口）
  const [tab, setTab] = useState<OverviewTab>('income');

  // 分类 tab 内的月份状态：旧看板沿用 calendarMonth 那种独立月份 state
  const [categoryMonth, setCategoryMonth] = useState<string>(() => monthKeyOf(Date.now()));

  // 天气（SWR：缓存先画，后台回源；副作用必须用 effect）
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getWeatherSync().then((c) => {
      if (cancelled || !c) return;
      setWeather(c);
    });
    void refreshWeather().then((f) => {
      if (cancelled || !f) return;
      setWeather(f);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* 实时数据（REST）—— 真实模式永远真实数据 */
  const spaceId = useSpaceId();
  const spaceQuery = spaceId ? `?spaceId=${spaceId}` : '';
  const today = useMemo(() => new Date(), []);

  const accountsRes = useApi<Account[]>(`/api/accounts${spaceQuery}`, [spaceId]);
  const transactionsRes = useApi<Transaction[]>(`/api/transactions${spaceQuery}`, [spaceId]);
  const goalsRes = useApi<Goal[]>(`/api/goals${spaceQuery}`, [spaceId]);
  const budgetsRes = useApi<Budget[]>(`/api/budgets${spaceQuery}`, [spaceId]);
  const categoriesRes = useApi<Category[]>('/api/categories');
  const nicknameRes = useApi<{ value?: string }>('/api/kv/nickname');
  const summaryRes = useApi<SummaryRow>('/api/summary');

  const accounts = accountsRes.data ?? [];
  const transactions = transactionsRes.data ?? [];
  const goals = goalsRes.data ?? [];
  const budgets = budgetsRes.data ?? [];
  const categories = categoriesRes.data ?? [];
  const summary = summaryRes.data;
  const nickname = nicknameRes.data?.value || '用户';
  const loading = accountsRes.loading || transactionsRes.loading || summaryRes.loading;

  /* 聚合：把核心 Transaction 行映射成 TxRow（与 lab TxRow 同形） */
  const txRows: TxRow[] = useMemo(
    () =>
      transactions.map((t) => ({
        date: t.date,
        amount: t.amount,
        type: t.type,
        name: t.name,
        categoryId: t.categoryId ?? null,
        accountId: t.accountId ?? null,
      })),
    [transactions],
  );
  const accountRows: AccountRow[] = useMemo(
    () =>
      accounts.map((a) => ({
        name: a.name,
        balance: a.balance,
        includeInNetAsset: a.includeInNetAsset ? 1 : 0,
      })),
    [accounts],
  );
  const goalRows: GoalRow[] = useMemo(
    () => goals.map((g) => ({ name: g.name, currentAmount: g.currentAmount, targetAmount: g.targetAmount })),
    [goals],
  );

  /* monthlyAgg：12 月序列 + 净资产序列 + 储蓄率序列 + 切片 + 统计 */
  const monthly = useMemo(() => toMonthlyPoints(txRows, today.getTime()), [txRows, today]);
  const netAssetMonthly = useMemo(
    () => toNetAssetMonthlySeries(monthly, summary?.netAsset ?? 0),
    [monthly, summary],
  );
  const savingsRateSeries = useMemo(() => toSavingsRateSeries(monthly), [monthly]);
  const slices = useMemo(() => toSlices(accountRows), [accountRows]);
  const stats = useMemo(
    () =>
      toLabStats(
        summary ?? { netAsset: 0, monthIncome: 0, monthExpense: 0, mom: null },
        monthly,
      ),
    [summary, monthly],
  );

  /* donut 中心总额：正余额资产账户合计（与 toSlices 同源） */
  const netAssetTotal = useMemo(() => slices.reduce((s, sl) => s + sl.value, 0), [slices]);

  /* 预算进度（calculations 已存在；本期已花按预算自身周期聚合） */
  const budgetProgress = useMemo(
    () => buildBudgetProgress(budgets, transactions, today),
    [budgets, transactions, today],
  );

  // AI 建议卡上下文：只用概况级数字（纯函数可测），不塞原始流水
  const insightContext = useMemo(
    () =>
      buildInsightContext({
        netAsset: stats.netAsset.amount,
        savingsRate: stats.savings.amount,
        monthly,
        budgets: budgetProgress.map((b) => ({ name: b.budget.name, spent: b.spent, amount: b.budget.amount })),
        goals: goals.map((g) => ({ name: g.name, current: g.currentAmount, target: g.targetAmount })),
      }),
    [stats, monthly, budgetProgress, goals],
  );

  // AI 卡右侧指标 chip：净资产/本月结余/储蓄率（Hero 摘要位）
  const insightChips = useMemo(() => {
    const last = monthly[monthly.length - 1];
    // 值不带货币符号（单位进 label）——chip 窄格塞不下 "¥ 37,033.25"，会触发截断
    const num = (n: number) => n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return [
      { label: '净资产（元）', value: num(stats.netAsset.amount) },
      {
        label: '本月结余（元）',
        value: num(last.balance),
        tone: (last.balance >= 0 ? 'income' : 'expense') as 'income' | 'expense' | undefined,
      },
      { label: '储蓄率', value: `${stats.savings.amount.toFixed(1)}%` },
    ];
  }, [stats, monthly]);

  /* 还款提醒：credit / debt 且余额为正（待还款） */
  const repayAccounts = useMemo(
    () => accounts.filter((a) => (a.type === 'credit' || a.type === 'debt') && a.balance > 0),
    [accounts],
  );

  /* 最近交易表：按日期降序，前 6 条 */
  const recentTx = useMemo(
    () =>
      [...transactions]
        .sort((a, b) => b.date - a.date)
        .slice(0, 6)
        .map((t) => {
          const cat = categories.find((c) => c.id === t.categoryId);
          const acct = accounts.find((a) => a.id === t.accountId);
          return {
            id: t.id ?? 0,
            date: dateKeyOf(t.date),
            name: t.name || cat?.name || '未命名',
            category: cat?.name ?? '未分类',
            account: acct?.name ?? '',
            amount: t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : 0,
          };
        }),
    [transactions, categories, accounts],
  );

  /* 分类 tab：monthly 该月 expense 按 category 聚合 + 排行 + 月份翻页器 */
  const categoryMonthKey = categoryMonth;
  const categoryMonthLabel = (() => {
    const [y, m] = categoryMonthKey.split('-').map(Number);
    return `${y}年${m}月`;
  })();
  const minCategoryMonth = useMemo(() => {
    let min: number | null = null;
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      if (t.includeInAsset === false) continue;
      if (min === null || t.date < min) min = t.date;
    }
    return min === null ? null : monthKeyOf(min);
  }, [transactions]);
  const currentCategoryMonth = monthKeyOf(today.getTime());

  const categoryRows = useMemo(() => {
    const [y, m] = categoryMonthKey.split('-').map(Number);
    const start = new Date(y, m - 1, 1, 0, 0, 0, 0).getTime();
    const end = new Date(y, m, 1, 0, 0, 0, 0).getTime();
    const map = new Map<string, number>();
    let total = 0;
    for (const t of transactions) {
      if (t.type !== 'expense') continue;
      if (t.includeInAsset === false) continue;
      if (t.date < start || t.date >= end) continue;
      const cat = categories.find((c) => c.id === t.categoryId);
      const key = cat?.name ?? '未分类';
      map.set(key, (map.get(key) ?? 0) + t.amount);
      total += t.amount;
    }
    const items = Array.from(map.entries())
      .map(([name, value]) => ({ name, value, pct: total > 0 ? (value / total) * 100 : 0 }))
      .sort((a, b) => b.value - a.value);
    return { items, total };
  }, [transactions, categories, categoryMonthKey]);

  const stepCategoryMonth = (delta: -1 | 1) => {
    const [y, m] = categoryMonthKey.split('-').map(Number);
    const next = new Date(y, m - 1 + delta, 1);
    const nextKey = monthKeyOf(next.getTime());
    if (nextKey > currentCategoryMonth) return;
    if (minCategoryMonth && nextKey < minCategoryMonth) return;
    setCategoryMonth(nextKey);
  };

  /* Tab → 折线色（首三 tab：收入绿/支出红/结余炭黑） */
  const tabColor: 'brand' | 'income' | 'expense' =
    tab === 'income' ? 'income' : tab === 'expense' ? 'expense' : 'brand';

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      {/* 局部样式：暗色下 income / expense 折线反转（chart-brand 已有） */}
      <style>{`
        .chart-income { color: ${CHART_COLORS.income}; }
        .dark .chart-income { color: #34d399; }
        .chart-expense { color: ${CHART_COLORS.expense}; }
        .dark .chart-expense { color: #f87171; }
        .dash-donut-center {
          position: absolute; inset: 0; display: flex; flex-direction: column;
          align-items: center; justify-content: center; pointer-events: none;
        }
      `}</style>

      <div className="p-4 lg:p-8">
        <div className="max-w-[1400px] mx-auto space-y-6">
          {/* 头部：标题 + 眼睛 + 问候 + 日期 + 天气 */}
          <header className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-text dark:text-text-dark">
                <IconLayoutDashboard size={20} className="text-text-muted dark:text-text-muted-dark" />
                数据看板
              </h1>
              <p className="mt-1 text-sm text-text-muted dark:text-text-muted-dark">
                你好，{nickname} 👋 · {greetingByHour(today.getHours())}，今天是{' '}
                {`${today.getFullYear()}年${today.getMonth() + 1}月${today.getDate()}日`}，{weekdayCn(dayjs(today))}
              </p>
              {weather && (
                <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                  {wmoToText(weather.weathercode).icon} {weather.cityName} {wmoToText(weather.weathercode).label}{' '}
                  {Math.round(weather.temperature)}°C
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={() => setHideAmounts((v) => !v)}
              aria-pressed={hideAmounts}
              aria-label={hideAmounts ? '显示金额' : '隐藏金额'}
              title={hideAmounts ? '显示金额' : '隐藏金额'}
              className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg-card dark:hover:bg-bg-card-dark transition-colors cursor-pointer"
            >
              {hideAmounts ? <IconEyeClosed size={18} /> : <IconEye size={18} />}
            </button>
          </header>

          {/* loading：骨架（仅首屏，后续走 SWR 复用缓存） */}
          {loading && !summary ? (
            <div className="space-y-4" aria-hidden>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} className="h-32 card animate-pulse" />
                ))}
              </div>
            </div>
          ) : (
            <>
              {/* 四统计卡横排 */}
              <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <StatCard
                  testid="dash-stat-netAsset"
                  label="净资产"
                  amount={stats.netAsset.amount}
                  deltaPct={stats.netAsset.deltaPct}
                  icon={<IconWallet size={18} />}
                  spark={netAssetMonthly}
                  tone="brand"
                  hide={hideAmounts}
                />
                <StatCard
                  testid="dash-stat-income"
                  label="本月收入"
                  amount={stats.income.amount}
                  deltaPct={stats.income.deltaPct}
                  icon={<IconArrowUpRight size={18} />}
                  spark={monthly.map((m) => ({ value: m.income }))}
                  tone="income"
                  hide={hideAmounts}
                />
                <StatCard
                  testid="dash-stat-expense"
                  label="本月支出"
                  amount={stats.expense.amount}
                  deltaPct={stats.expense.deltaPct}
                  invert
                  icon={<IconArrowDownRight size={18} />}
                  spark={monthly.map((m) => ({ value: m.expense }))}
                  tone="expense"
                  hide={hideAmounts}
                />
                <StatCard
                  testid="dash-stat-savings"
                  label="储蓄率"
                  amount={stats.savings.amount}
                  deltaPct={stats.savings.deltaPct}
                  icon={<IconPigMoney size={18} />}
                  spark={savingsRateSeries}
                  tone="brand"
                  hide={hideAmounts}
                />
              </section>

              {/* Overview + 资产分布 + 目标进度（两栏：xl:8/4） */}
              <section className="grid grid-cols-1 gap-4 xl:grid-cols-12">
                {/* Overview 大区 */}
                {/* flex 列布局：图表区 flex-1 填满卡片，随右栏等高不留白（2026-10-06 空白修复） */}
                <div className="card p-5 xl:col-span-8 flex flex-col" data-testid="dash-overview">
                  <div className="mb-3 flex items-start justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold text-text dark:text-text-dark">总览</h2>
                      <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        {tab === 'category' ? `${categoryMonthLabel}分类占比` : '近 12 个月收支走势'}
                      </p>
                    </div>
                    {/* Tab 切换：激活色跟随语义（收入绿/支出红/结余炭黑） */}
                    <div
                      className="inline-flex h-8 rounded-lg bg-bg dark:bg-bg-dark p-0.5 text-xs"
                      role="tablist"
                    >
                      {(['income', 'expense', 'balance', 'category'] as const).map((t) => {
                        const active = tab === t;
                        const label =
                          t === 'income' ? '收入' : t === 'expense' ? '支出' : t === 'balance' ? '结余' : '分类';
                        const activeColor =
                          t === 'income'
                            ? 'text-income'
                            : t === 'expense'
                              ? 'text-expense'
                              : t === 'balance'
                                ? 'text-text dark:text-text-dark'
                                : 'text-text dark:text-text-dark';
                        return (
                          <button
                            key={t}
                            type="button"
                            role="tab"
                            aria-selected={active}
                            onClick={() => setTab(t)}
                            data-testid={`dash-tab-${t}`}
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

                  {tab === 'category' ? (
                    /* 分类 tab：饼图 + 排行 + 月份翻页器 */
                    <div data-testid="dash-category-tab">
                      <div className="flex items-center justify-end gap-1 mb-3 text-xs text-text-muted dark:text-text-muted-dark">
                        <button
                          type="button"
                          onClick={() => stepCategoryMonth(-1)}
                          disabled={categoryMonthKey === minCategoryMonth}
                          aria-label="上一月"
                          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg dark:hover:bg-bg-card-dark disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                        >
                          <IconChevronLeft size={14} />
                        </button>
                        <span className="tabular-nums font-medium text-text dark:text-text-dark min-w-[4.5rem] text-center">
                          {categoryMonthLabel}
                        </span>
                        <button
                          type="button"
                          onClick={() => stepCategoryMonth(1)}
                          disabled={categoryMonthKey === currentCategoryMonth}
                          aria-label="下一月"
                          className="w-6 h-6 flex items-center justify-center rounded hover:bg-bg dark:hover:bg-bg-card-dark disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer"
                        >
                          <IconChevronRight size={14} />
                        </button>
                      </div>
                      {categoryRows.items.length === 0 ? (
                        <div className="py-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                          本月暂无分类数据
                        </div>
                      ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                          <div className="h-56">
                            <ResponsiveContainer width="100%" height="100%">
                              <PieChart>
                                <Pie
                                  data={categoryRows.items}
                                  dataKey="value"
                                  nameKey="name"
                                  cx="50%"
                                  cy="50%"
                                  innerRadius="55%"
                                  outerRadius="85%"
                                  paddingAngle={2}
                                  animationDuration={CHART_ANIMATION_MS}
                                >
                                  {categoryRows.items.map((_, i) => (
                                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                                  ))}
                                </Pie>
                                <Tooltip
                                  formatter={(v) => formatMoney(Number(v))}
                                />
                              </PieChart>
                            </ResponsiveContainer>
                          </div>
                          <ul className="space-y-1.5 text-xs max-h-56 overflow-y-auto">
                            {categoryRows.items.map((c, i) => (
                              <li
                                key={c.name}
                                className="flex items-center gap-2"
                              >
                                <span
                                  className="h-2 w-2 rounded-sm flex-none"
                                  style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                                />
                                <span className="flex-1 truncate text-text dark:text-text-dark">
                                  {c.name}
                                </span>
                                <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                                  {c.pct.toFixed(1)}%
                                </span>
                                <span className="tabular-nums w-20 text-right text-text dark:text-text-dark">
                                  {hideAmounts ? '¥ ******' : formatMoney(c.value, false)}
                                </span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  ) : (
                    /* 前 3 tab：12 月面积图（flex-1 填满卡片剩余高度） */
                    <div className="flex-1 min-h-64 -mx-2" data-testid={`dash-chart-${tab}`}>
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
                            animationDuration={CHART_ANIMATION_MS}
                            animationEasing={threePhaseEasing as unknown as 'ease-out'}
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                </div>

                {/* 右栏：还款提醒 + 资产分布 + 目标进度 + 预算执行 */}
                <div className="space-y-4 xl:col-span-4">
                  {/* 还款提醒：仅待还款非空才渲染 */}
                  {repayAccounts.length > 0 && (
                    <div className="card p-5" data-testid="dash-repay">
                      <h2 className="text-sm font-semibold text-text dark:text-text-dark">还款提醒</h2>
                      <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                        待还款账户
                      </p>
                      <ul className="mt-3 space-y-2">
                        {repayAccounts.map((a) => (
                          <li
                            key={a.id}
                            className="flex items-center justify-between gap-2 text-sm"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <span className="w-7 h-7 rounded-lg bg-expense-soft dark:bg-expense-soft-dark flex items-center justify-center text-expense flex-none">
                                <IconAlertTriangle size={14} />
                              </span>
                              <div className="min-w-0">
                                <div className="truncate">{a.name}</div>
                                <div className="text-xs text-text-muted dark:text-text-muted-dark">
                                  {a.type === 'credit' ? '信用卡' : '债务'}
                                </div>
                              </div>
                            </div>
                            <span className="text-expense tabular-nums font-medium">
                              {hideAmounts ? '¥ ******' : formatMoney(a.balance, false)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* 资产分布 donut（中心叠加净资产总额） */}
                  <div className="card p-5" data-testid="dash-donut">
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">资产分布</h2>
                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">净资产构成</p>
                    {slices.length === 0 ? (
                      <div className="mt-4 py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        暂无资产账户
                      </div>
                    ) : (
                      <>
                        <div className="relative mt-3 h-44">
                          <ResponsiveContainer width="100%" height="100%">
                            <PieChart>
                              <Pie
                                data={slices}
                                dataKey="value"
                                nameKey="name"
                                innerRadius="60%"
                                outerRadius="85%"
                                paddingAngle={2}
                                animationDuration={CHART_ANIMATION_MS}
                              >
                                {slices.map((_, i) => (
                                  <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                                ))}
                              </Pie>
                              <Tooltip formatter={(v) => formatMoney(Number(v))} />
                            </PieChart>
                          </ResponsiveContainer>
                          <div className="dash-donut-center">
                            <div className="text-[10px] text-text-muted dark:text-text-muted-dark">净资产</div>
                            <div className="text-base font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
                              {hideAmounts ? '¥ ******' : formatMoney(netAssetTotal)}
                            </div>
                          </div>
                        </div>
                        <ul className="mt-2 space-y-1.5 text-xs">
                          {slices.map((s, i) => (
                            <li key={s.name} className="flex items-center gap-2">
                              <span
                                className="h-2 w-2 rounded-sm flex-none"
                                style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                              />
                              <span className="flex-1 truncate text-text dark:text-text-dark">{s.name}</span>
                              <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                                {hideAmounts ? '¥ ******' : formatMoney(s.value)}
                              </span>
                            </li>
                          ))}
                        </ul>
                        <a
                          href="/account/list"
                          className="mt-3 flex items-center justify-end gap-1 text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                        >
                          共 {accounts.length} 个账户 · 详情 <IconArrowRight size={12} />
                        </a>
                      </>
                    )}
                  </div>

                  {/* 目标进度 */}
                  <div className="card p-5" data-testid="dash-goals">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">目标进度</h2>
                        <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                          活跃追踪
                        </p>
                      </div>
                      {goals.length > 0 && (
                        <a
                          href="/goal/list"
                          className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                        >
                          详情 <IconArrowRight size={12} />
                        </a>
                      )}
                    </div>
                    {goalRows.length === 0 ? (
                      <div className="mt-4 py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        暂无目标
                      </div>
                    ) : (
                      <ul className="mt-3 space-y-3">
                        {goalRows.slice(0, 3).map((g) => {
                          const pct =
                            g.targetAmount > 0
                              ? Math.min(100, Math.round((g.currentAmount / g.targetAmount) * 100))
                              : 0;
                          return (
                            <li key={g.name}>
                              <div className="flex items-baseline justify-between text-xs">
                                <span className="font-medium text-text dark:text-text-dark">
                                  {g.name}
                                </span>
                                <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                                  {pct}%
                                </span>
                              </div>
                              <div className="mt-1 h-1.5 rounded-full bg-bg dark:bg-bg-dark overflow-hidden">
                                <div
                                  className="h-full bg-income rounded-full transition-[width] duration-500"
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                              <div className="mt-1 flex items-center justify-between text-[11px] tabular-nums text-text-muted dark:text-text-muted-dark">
                                <span>{hideAmounts ? '******' : formatMoney(g.currentAmount, false)}</span>
                                <span>目标 {hideAmounts ? '******' : formatMoney(g.targetAmount, false)}</span>
                              </div>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {/* 预算执行 */}
                  <div className="card p-5" data-testid="dash-budget">
                    <div className="flex items-center justify-between">
                      <div>
                        <h2 className="text-sm font-semibold text-text dark:text-text-dark">预算执行</h2>
                        <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                          本期已花
                        </p>
                      </div>
                      {budgetProgress.length > 0 && (
                        <a
                          href="/budget"
                          className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                        >
                          详情 <IconArrowRight size={12} />
                        </a>
                      )}
                    </div>
                    {budgetProgress.length === 0 ? (
                      <div className="mt-4 py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">
                        暂无预算
                      </div>
                    ) : (
                      <ul className="mt-3 space-y-3">
                        {budgetProgress.slice(0, 3).map(({ budget, spent, pct, overspent }) => (
                          <li key={budget.id} className="text-sm">
                            <div className="flex items-baseline justify-between gap-2">
                              <span className="truncate">{budget.name}</span>
                              <span
                                className={clsx(
                                  'flex-none text-xs tabular-nums',
                                  overspent
                                    ? 'text-danger dark:text-danger-dark'
                                    : 'text-text-muted dark:text-text-muted-dark',
                                )}
                              >
                                {hideAmounts
                                  ? '****** / ******'
                                  : `${formatMoney(spent, false)} / ${formatMoney(budget.amount, false)}`}
                              </span>
                            </div>
                            <div className="mt-1.5 h-1.5 rounded-full bg-bg dark:bg-bg-dark overflow-hidden">
                              <div
                                className={clsx(
                                  'h-full rounded-full transition-[width] duration-500',
                                  overspent ? 'bg-income' : 'bg-expense',
                                )}
                                style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                              />
                            </div>
                            {overspent && !hideAmounts && (
                              <div className="mt-1 text-[11px] text-danger dark:text-danger-dark">
                                已超支 {formatMoney(spent - budget.amount, false)}
                              </div>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </section>

              {/* 最近交易表 */}
              <section className="card p-5" data-testid="dash-recent-tx">
                <div className="mb-3 flex items-baseline justify-between">
                  <div>
                    <h2 className="text-sm font-semibold text-text dark:text-text-dark">最近交易</h2>
                    <p className="mt-0.5 text-xs text-text-muted dark:text-text-muted-dark">
                      最新 {recentTx.length} 笔
                    </p>
                  </div>
                  {recentTx.length > 0 && (
                    <a
                      href="/transaction"
                      className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                    >
                      详情 <IconArrowRight size={12} />
                    </a>
                  )}
                </div>
                {recentTx.length === 0 ? (
                  <div className="py-8 text-center text-sm text-text-muted dark:text-text-muted-dark">
                    暂无交易
                  </div>
                ) : (
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
                        {recentTx.map((tx) => (
                          <tr
                            key={tx.id}
                            className="border-b border-border/60 dark:border-border-dark/60 last:border-b-0"
                          >
                            <td className="py-2.5 pr-3 tabular-nums text-text-muted dark:text-text-muted-dark">
                              {tx.date}
                            </td>
                            <td className="py-2.5 pr-3 text-text dark:text-text-dark">{tx.name}</td>
                            <td className="py-2.5 pr-3 text-text-muted dark:text-text-muted-dark">
                              {tx.category}
                            </td>
                            <td className="py-2.5 pr-3 text-text-muted dark:text-text-muted-dark">
                              {tx.account}
                            </td>
                            <td
                              className={clsx(
                                'py-2.5 text-right tabular-nums font-medium',
                                tx.amount >= 0 ? 'text-income' : 'text-expense',
                              )}
                            >
                              {hideAmounts
                                ? '******'
                                : `${tx.amount >= 0 ? '+' : ''}${formatMoney(tx.amount)}`}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              {/* AI 财务建议：全宽 Hero 摘要卡（右栏窄条会拉长 Overview 图——2026-10-07 重构） */}
              <DashboardInsightCard contextText={insightContext} chips={insightChips} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}