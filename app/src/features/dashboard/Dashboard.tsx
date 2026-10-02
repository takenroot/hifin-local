/**
 * 看板 Dashboard（功能完整版）
 * ---------------------------------------------------------------
 * 布局：左主右副（右侧栏约 280px）。
 * - 欢迎区：昵称（kv.nickname，默认"用户"）+ 按时段问候语 + 当前日期星期
 * - 资产概览三卡：净资产 / 本月收入 / 本月支出，带环比上月涨跌幅（绿涨红跌）
 * - 资产趋势：recharts 面积图，近 30 天净资产估算
 * - 资产分布：Tab（按账户/按交易方式）环形图
 * - 收支日历：当月网格，每日收入/支出小计，点击弹当日流水列表
 * - 右侧栏：还款提醒 / 账户管理 / 目标管理 / 预算管理（占位）/ 最近交易
 *
 * ⚠️ 路由冲突说明：本模块 routes.tsx 中仍写 path: 'home'，
 *    与阶段 1 骨架 src/features/home/Dashboard.tsx 共用同一路径，
 *    集成阶段由 App.tsx 的 glob 收集决定保留哪一个。
 *    本文件**未修改** App.tsx 与 features/home。
 */
import { useEffect, useMemo, useState } from 'react';
import dayjs from 'dayjs';
import { useNavigate } from 'react-router-dom';
import {
  IconLayoutDashboard,
  IconEye,
  IconEyeClosed,
  IconPlus,
  IconWallet,
  IconTargetArrow,
  IconCircleDashed,
  IconArrowUpRight,
  IconArrowDownLeft,
  IconArrowRight,
  IconAlertTriangle,
  IconSettings,
} from '@tabler/icons-react';
import clsx from 'clsx';
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  CartesianGrid,
} from 'recharts';
import {
  Card,
  Badge,
  Button,
  EmptyState,
  Modal,
  Tabs,
  ProgressBar,
  PageHeader,
} from '@/components/ui';
import { useSpaceId } from '@/db';
import type { Category, Goal } from '@/db';
import { useApi } from '@/hooks/useApi';
import { toAccounts, toTransactions, type RestAccount, type RestTransaction } from '@/features/accounts/rest';

import {
  calcNetAsset,
  sumIncome,
  sumExpense,
  netAssetTrend,
  distributionByAccount,
  distributionByAccountType,
  buildCalendar,
  transactionsOnDay,
} from './calculations';
import {
  fetchWeather,
  getSavedCity,
  saveCity,
  wmoToText,
  CITY_PRESETS,
  type WeatherInfo,
} from './weather';
import {
  formatMoney,
  formatPercent,
  monthOverMonth,
  trendToneClass,
  greetingByHour,
  weekdayCn,
} from './format';

// 饼图配色（与设计系统色板一致）
const PIE_COLORS = [
  '#10b981',
  '#6366f1',
  '#f59e0b',
  '#ef4444',
  '#0ea5e9',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
];

/* 隐藏金额时显示的占位字符（与币种符号宽度接近） */
const AMOUNT_HIDDEN_PREFIX = '¥ ';
const AMOUNT_HIDDEN_BODY = '••••••';

/**
 * 读取/写入看板顶栏"隐藏金额"开关的 localStorage key。
 * - 浏览器禁用 localStorage 时静默回退为 false。
 */
function readHideAmounts(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem('hifin:hideAmounts') === 'true';
  } catch {
    return false;
  }
}

function writeHideAmounts(value: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem('hifin:hideAmounts', String(value));
  } catch {
    // ignore: 隐私模式 / 配额耗尽等场景下不可写
  }
}

export default function Dashboard() {
  const navigate = useNavigate();
  const today = useMemo(() => dayjs(), []);
  const currentMonth = useMemo(() => today.startOf('month'), [today]);
  const prevMonth = useMemo(() => today.subtract(1, 'month').startOf('month'), [today]);

  // 顶栏"隐藏金额"开关：默认显示金额（false），持久化到 hifin:hideAmounts
  const [hideAmounts, setHideAmounts] = useState<boolean>(() => readHideAmounts());
  useEffect(() => {
    writeHideAmounts(hideAmounts);
  }, [hideAmounts]);

  // 天气（Open-Meteo，失败静默隐藏）
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [cityModalOpen, setCityModalOpen] = useState(false);
  const [currentCity, setCurrentCity] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    void fetchWeather().then((w) => {
      if (!cancelled && w) {
        setWeather(w);
        setCurrentCity(w.cityName);
      }
    });
    void getSavedCity().then((c) => {
      if (!cancelled) setCurrentCity((prev) => prev || c.name);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 实时数据（REST）。空间过滤直接拼 URL：spaceId=0 表示"全部空间"，不带参数由后端返回全量。
  const spaceId = useSpaceId();
  const spaceQuery = spaceId ? `?spaceId=${spaceId}` : '';

  const accountsRes = useApi<RestAccount[]>(`/api/accounts${spaceQuery}`, [spaceId]);
  const transactionsRes = useApi<RestTransaction[]>(`/api/transactions${spaceQuery}`, [spaceId]);
  const goalsRes = useApi<Goal[]>(`/api/goals${spaceQuery}`, [spaceId]);
  const categoriesRes = useApi<Category[]>('/api/categories');
  // 昵称：/api/kv/:key 在键不存在时返回 404，属于"未设置昵称"的正常状态，故不计入 error。
  const nicknameRes = useApi<{ value?: string }>('/api/kv/nickname');

  const accounts = useMemo(() => toAccounts(accountsRes.data), [accountsRes.data]);
  const transactions = useMemo(() => toTransactions(transactionsRes.data), [transactionsRes.data]);
  const goals = goalsRes.data ?? [];
  const categories = categoriesRes.data ?? [];

  const loading = accountsRes.loading || transactionsRes.loading;
  const loadError = accountsRes.error ?? transactionsRes.error ?? goalsRes.error ?? categoriesRes.error;

  const nickname = nicknameRes.data?.value || '用户';

  // 计算概览
  const netAsset = useMemo(() => calcNetAsset(accounts), [accounts]);
  const monthIncome = useMemo(
    () => sumIncome(transactions, currentMonth.valueOf(), currentMonth.add(1, 'month').valueOf()),
    [transactions, currentMonth],
  );
  const monthExpense = useMemo(
    () => sumExpense(transactions, currentMonth.valueOf(), currentMonth.add(1, 'month').valueOf()),
    [transactions, currentMonth],
  );
  const prevMonthIncome = useMemo(
    () => sumIncome(transactions, prevMonth.valueOf(), currentMonth.valueOf()),
    [transactions, prevMonth, currentMonth],
  );
  const prevMonthExpense = useMemo(
    () => sumExpense(transactions, prevMonth.valueOf(), currentMonth.valueOf()),
    [transactions, prevMonth, currentMonth],
  );

  // 净资产上月估算 = 净资产 - 本月净额；用于环比
  const netDelta = useMemo(() => monthIncome - monthExpense, [monthIncome, monthExpense]);
  const netAssetPrev = useMemo(() => netAsset - netDelta, [netAsset, netDelta]);
  const netAssetMoM = useMemo(() => monthOverMonth(netAsset, netAssetPrev), [netAsset, netAssetPrev]);
  const incomeMoM = useMemo(
    () => monthOverMonth(monthIncome, prevMonthIncome),
    [monthIncome, prevMonthIncome],
  );
  const expenseMoM = useMemo(
    () => monthOverMonth(monthExpense, prevMonthExpense),
    [monthExpense, prevMonthExpense],
  );

  // 资产趋势
  const trendData = useMemo(
    () => netAssetTrend(accounts, transactions, 30),
    [accounts, transactions],
  );
  const hasTrend = trendData.some((d) => d.value !== 0);

  // 资产分布
  const [distTab, setDistTab] = useState<'account' | 'type'>('account');
  const distData = useMemo(
    () => (distTab === 'account' ? distributionByAccount(accounts) : distributionByAccountType(accounts)),
    [distTab, accounts],
  );
  const hasDistribution = distData.length > 0;

  // 日历
  const calendarDays = useMemo(() => buildCalendar(transactions, currentMonth), [transactions, currentMonth]);
  const [selectedDay, setSelectedDay] = useState<dayjs.Dayjs | null>(null);
  const dayTransactions = useMemo(
    () => (selectedDay ? transactionsOnDay(transactions, selectedDay) : []),
    [selectedDay, transactions],
  );

  // 右侧栏数据
  const repayAccounts = useMemo(
    () => accounts.filter((a) => (a.type === 'credit' || a.type === 'debt') && a.balance > 0),
    [accounts],
  );
  const accountTotal = useMemo(() => {
    let total = 0;
    for (const a of accounts) {
      if (!a.includeInNetAsset) continue;
      if (a.type === 'credit' || a.type === 'debt') continue;
      total += a.balance;
    }
    return total;
  }, [accounts]);

  const recentTransactions = useMemo(
    () =>
      [...transactions]
        .sort((a, b) => b.date - a.date)
        .slice(0, 5),
    [transactions],
  );

  return (
    <div className="min-h-full bg-bg dark:bg-bg-dark">
      <PageHeader
        title="数据看板"
        icon={<IconLayoutDashboard size={18} />}
        actions={
          <div className="flex items-center gap-2 text-text-muted">
            <button
              type="button"
              onClick={() => setHideAmounts((v) => !v)}
              aria-pressed={hideAmounts}
              aria-label={hideAmounts ? '显示金额' : '隐藏金额'}
              title={hideAmounts ? '显示金额' : '隐藏金额'}
              className="inline-flex items-center justify-center rounded-md p-1 text-text-muted hover:text-text dark:hover:text-text-dark hover:bg-bg-card dark:hover:bg-bg-card-dark transition-colors cursor-pointer"
            >
              {hideAmounts ? <IconEyeClosed size={18} /> : <IconEye size={18} />}
            </button>
          </div>
        }
      />

      <div className="p-4 lg:p-8">
        <div className="flex flex-col lg:flex-row gap-6 max-w-[1440px] mx-auto">
          {loadError ? (
            <EmptyState
              title="数据加载失败"
              description={`无法从服务端读取看板数据：${loadError}`}
            />
          ) : loading ? (
            <div className="flex-1 min-w-0 space-y-6">
              <div className="h-24 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="h-28 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
                <div className="h-28 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
                <div className="h-28 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
              </div>
              <div className="h-64 rounded-xl bg-bg dark:bg-bg-card-dark animate-pulse" />
            </div>
          ) : (
          <div className="flex-1 min-w-0 space-y-6">
            {/* 欢迎区 */}
            <section>
              <div className="flex items-baseline gap-3">
                <div className="text-2xl font-medium">
                  你好，{nickname} 👋
                </div>
              </div>
              <div className="text-sm text-text-muted mt-1 flex items-center gap-2 flex-wrap">
                <span>
                  {greetingByHour(today.hour())}，今天是 {today.format('YYYY年MM月DD日')}，{weekdayCn(today)}
                </span>
                {weather && (
                  <span className="inline-flex items-center gap-1 text-text-muted">
                    <span aria-hidden>{wmoToText(weather.weathercode).icon}</span>
                    <span>
                      {weather.cityName} {wmoToText(weather.weathercode).label} {Math.round(weather.temperature)}°C
                    </span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setCityModalOpen(true)}
                  className="inline-flex items-center text-text-muted hover:text-text dark:hover:text-text-dark transition-colors"
                  title="切换城市"
                >
                  <IconSettings size={14} />
                </button>
              </div>
            </section>

            {/* 资产概览三卡 */}
            <section>
              <h2 className="section-title mb-3">资产概览</h2>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <StatCard
                  label="净资产"
                  icon="💰"
                  tone="income"
                  amount={netAsset}
                  delta={netAssetMoM}
                  hide={hideAmounts}
                />
                <StatCard
                  label="本月收入"
                  icon="📥"
                  tone="income"
                  amount={monthIncome}
                  delta={incomeMoM}
                  hide={hideAmounts}
                />
                <StatCard
                  label="本月支出"
                  icon="📤"
                  tone="expense"
                  amount={monthExpense}
                  delta={expenseMoM}
                  expenseMode
                  hide={hideAmounts}
                />
              </div>
            </section>

            {/* 资产趋势 */}
            <section>
              <Card title="资产趋势" extra={<span className="text-xs text-text-muted">近 30 天</span>}>
                {hasTrend ? (
                  <div className="h-64 -mx-2">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={trendData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="dashNetGradient" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#6366f1" stopOpacity={0.4} />
                            <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border dark:text-border-dark" />
                        <XAxis
                          dataKey="date"
                          tick={{ fontSize: 11, fill: 'currentColor' }}
                          className="text-text-muted"
                          tickFormatter={(v: string) => dayjs(v).format('MM/DD')}
                          minTickGap={28}
                        />
                        <YAxis
                          tick={{ fontSize: 11, fill: 'currentColor' }}
                          className="text-text-muted"
                          width={60}
                          tickFormatter={(v: number) => {
                            if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`;
                            return String(v);
                          }}
                        />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--tw-bg-opacity, #fff)',
                            backgroundColor: '#fff',
                            border: '1px solid #e5e7eb',
                            borderRadius: 12,
                            fontSize: 12,
                          }}
                          formatter={(value: number | string) => [formatMoney(Number(value)), '净资产']}
                          labelFormatter={(label: string) => dayjs(label).format('YYYY-MM-DD')}
                        />
                        <Area
                          type="monotone"
                          dataKey="value"
                          stroke="#6366f1"
                          strokeWidth={2}
                          fill="url(#dashNetGradient)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <EmptyState title="暂无数据" description="添加账户和交易后，这里会显示资产走势" />
                )}
              </Card>
            </section>

            {/* 资产分布 */}
            <section>
              <Card
                title="资产分布"
                extra={
                  <Tabs
                    items={[
                      { key: 'account', label: '按账户' },
                      { key: 'type', label: '按交易方式' },
                    ]}
                    activeKey={distTab}
                    onChange={(k) => setDistTab(k as 'account' | 'type')}
                    variant="line"
                  />
                }
              >
                {hasDistribution ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 items-center">
                    <div className="h-64">
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie
                            data={distData}
                            dataKey="value"
                            nameKey="name"
                            cx="50%"
                            cy="50%"
                            innerRadius="55%"
                            outerRadius="85%"
                            paddingAngle={2}
                          >
                            {distData.map((_, i) => (
                              <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              backgroundColor: '#fff',
                              border: '1px solid #e5e7eb',
                              borderRadius: 12,
                              fontSize: 12,
                            }}
                            formatter={(value: number | string) => formatMoney(Number(value))}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="space-y-2">
                      {distData.map((d, i) => {
                        const sum = distData.reduce((s, x) => s + x.value, 0);
                        const pct = sum > 0 ? (d.value / sum) * 100 : 0;
                        return (
                          <div key={d.name} className="flex items-center gap-3 text-sm">
                            <span
                              className="w-3 h-3 rounded-sm flex-none"
                              style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                            />
                            <span className="flex-1 truncate">{d.name}</span>
                            <span className="text-text-muted tabular-nums">{pct.toFixed(1)}%</span>
                            <span className="font-medium tabular-nums w-24 text-right">
                              {formatMoney(d.value, false)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <EmptyState
                    title="暂无数据"
                    description={
                      distTab === 'account'
                        ? '添加账户并设置余额后，这里会显示各账户资产占比'
                        : '添加账户并设置余额后，这里会显示各交易方式资产占比'
                    }
                  />
                )}
              </Card>
            </section>

            {/* 收支日历 */}
            <section>
              <Card
                title="收支日历"
                extra={
                  <span className="text-xs text-text-muted">{currentMonth.format('YYYY 年 MM 月')}</span>
                }
              >
                <MonthCalendar
                  month={currentMonth}
                  days={calendarDays}
                  onSelect={(d) => setSelectedDay(d)}
                />
              </Card>
            </section>
          </div>
          )}

          {/* 右侧栏 280px */}
          <aside className="w-full lg:w-[280px] flex-none space-y-4">
            {/* 还款提醒 */}
            <Card title="还款提醒">
              {repayAccounts.length === 0 ? (
                <EmptyState title="暂无待还款" className="!py-8" />
              ) : (
                <div className="space-y-2">
                  {repayAccounts.map((a) => (
                    <div
                      key={a.id}
                      className="flex items-center justify-between gap-2 text-sm py-1.5"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="w-7 h-7 rounded-lg bg-expense-soft dark:bg-expense-soft-dark flex items-center justify-center text-expense">
                          <IconAlertTriangle size={14} />
                        </span>
                        <div className="min-w-0">
                          <div className="truncate">{a.name}</div>
                          <div className="text-xs text-text-muted">
                            {a.type === 'credit' ? '信用卡' : '债务'}
                          </div>
                        </div>
                      </div>
                      <span className="text-expense tabular-nums font-medium">
                        <MaskMoney value={a.balance} hide={hideAmounts} withSymbol={false} />
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {/* 账户管理 */}
            <Card
              title="账户管理"
              extra={
                accounts.length > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate('/account/list')}
                    className="text-xs text-text-muted hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                  >
                    详情 <IconArrowRight size={12} />
                  </button>
                )
              }
            >
              {accounts.length === 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/account/list?create=1')}
                  className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted hover:text-text dark:hover:text-text-dark transition"
                >
                  <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                    <IconWallet size={18} />
                  </span>
                  <span>快捷添加首个账户</span>
                </button>
              ) : (
                <div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-text-muted">共 {accounts.length} 个账户</span>
                    <span className="text-income tabular-nums font-medium">
                      <MaskMoney value={accountTotal} hide={hideAmounts} withSymbol={false} />
                    </span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    block
                    className="mt-3"
                    icon={<IconPlus size={14} />}
                    onClick={() => navigate('/account/list?create=1')}
                  >
                    添加账户
                  </Button>
                </div>
              )}
            </Card>

            {/* 目标管理 */}
            <Card
              title="目标管理"
              extra={
                goals.length > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate('/goal/list')}
                    className="text-xs text-text-muted hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                  >
                    详情 <IconArrowRight size={12} />
                  </button>
                )
              }
            >
              {goals.length === 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/goal/list?create=1')}
                  className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted hover:text-text dark:hover:text-text-dark transition"
                >
                  <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                    <IconTargetArrow size={18} />
                  </span>
                  <span>快捷添加首个目标</span>
                </button>
              ) : (
                <div className="space-y-3">
                  {goals.slice(0, 3).map((g) => {
                    const pct = g.targetAmount > 0 ? (g.currentAmount / g.targetAmount) * 100 : 0;
                    return (
                      <div key={g.id} className="text-sm">
                        <div className="flex items-center justify-between mb-1">
                          <span className="truncate flex-1">{g.name}</span>
                          <span className="text-xs text-text-muted ml-2 tabular-nums">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                        <ProgressBar value={Math.max(0, Math.min(100, pct))} tone="income" size="sm" />
                      </div>
                    );
                  })}
                  <Button
                    variant="secondary"
                    size="sm"
                    block
                    icon={<IconPlus size={14} />}
                    onClick={() => navigate('/goal/list?create=1')}
                  >
                    添加目标
                  </Button>
                </div>
              )}
            </Card>

            {/* 预算管理 */}
            <Card title="预算管理">
              <div className="flex flex-col items-center justify-center py-6 text-sm text-text-muted">
                <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                  <IconCircleDashed size={18} />
                </span>
                <span>敬请期待</span>
              </div>
            </Card>

            {/* 最近交易 */}
            <Card
              title="最近交易"
              extra={
                recentTransactions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => navigate('/transaction')}
                    className="text-xs text-text-muted hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                  >
                    详情 <IconArrowRight size={12} />
                  </button>
                )
              }
            >
              {recentTransactions.length === 0 ? (
                <button
                  type="button"
                  onClick={() => navigate('/transaction?create=1')}
                  className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted hover:text-text dark:hover:text-text-dark transition"
                >
                  <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                    <IconArrowUpRight size={18} />
                  </span>
                  <span>快捷添加首个交易</span>
                </button>
              ) : (
                <div className="space-y-2">
                  {recentTransactions.map((t) => {
                    const cat = categories.find((c) => c.id === t.categoryId);
                    const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '';
                    const tone =
                      t.type === 'income' ? 'text-income' : t.type === 'expense' ? 'text-expense' : 'text-text-muted';
                    return (
                      <div
                        key={t.id}
                        className="flex items-center gap-2 py-1.5 text-sm"
                      >
                        <span className="w-7 h-7 rounded-lg bg-bg dark:bg-bg-card-dark flex items-center justify-center text-base flex-none">
                          {cat?.icon || (t.type === 'transfer' ? '🔁' : '💸')}
                        </span>
                        <div className="flex-1 min-w-0">
                          <div className="truncate">{t.name || cat?.name || '未命名'}</div>
                          <div className="text-xs text-text-muted">
                            {dayjs(t.date).format('MM-DD')}
                          </div>
                        </div>
                        <span className={clsx('tabular-nums font-medium', tone)}>
                          {hideAmounts ? (
                            <MaskMoney value={t.amount} hide withSymbol={false} />
                          ) : (
                            <>
                              {sign}
                              {formatMoney(t.amount, false)}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          </aside>
        </div>
      </div>

      {/* 当日流水 Modal */}
      <Modal
        open={!!selectedDay}
        onClose={() => setSelectedDay(null)}
        title={selectedDay ? `${selectedDay.format('YYYY年MM月DD日')} 流水` : ''}
        width={520}
      >
        {dayTransactions.length === 0 ? (
          <EmptyState title="当日暂无流水" />
        ) : (
          <div className="divide-y divide-border dark:divide-border-dark -mx-2">
            {dayTransactions.map((t) => {
              const cat = categories.find((c) => c.id === t.categoryId);
              const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '';
              const tone =
                t.type === 'income'
                  ? 'text-income'
                  : t.type === 'expense'
                  ? 'text-expense'
                  : 'text-text-muted';
              return (
                <div key={t.id} className="flex items-center gap-3 px-2 py-3">
                  <span className="w-9 h-9 rounded-lg bg-bg dark:bg-bg-card-dark flex items-center justify-center text-lg flex-none">
                    {cat?.icon || (t.type === 'transfer' ? '🔁' : t.type === 'income' ? '💰' : '💸')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate">
                      {t.name || cat?.name || (t.type === 'transfer' ? '转账' : '未命名')}
                    </div>
                    <div className="text-xs text-text-muted flex items-center gap-2 mt-0.5">
                      <span>{dayjs(t.date).format('HH:mm')}</span>
                      {cat && <Badge tone="neutral">{cat.name}</Badge>}
                      {t.remark && <span className="truncate">· {t.remark}</span>}
                    </div>
                  </div>
                  <span className={clsx('tabular-nums font-medium', tone)}>
                    {sign}
                    {formatMoney(t.amount, false)}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </Modal>

      {/* 城市切换 Modal（浏览器定位失败/被拒绝时使用选定城市） */}
      <Modal
        open={cityModalOpen}
        onClose={() => setCityModalOpen(false)}
        title="天气城市"
        width={400}
      >
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            浏览器定位可用时优先使用当前位置；否则展示所选城市的天气。
          </p>
          <div className="grid grid-cols-3 gap-2">
            {CITY_PRESETS.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => {
                  void saveCity(c).then(() => fetchWeather());
                  setCurrentCity(c.name);
                  setWeather(null);
                  setCityModalOpen(false);
                  // 重新拉取（缓存键随城市变化）
                  void fetchWeather().then((w) => w && setWeather(w));
                }}
                className={clsx(
                  'rounded-xl border px-3 py-2 text-sm transition-colors',
                  currentCity === c.name
                    ? 'border-text dark:border-text-dark bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark'
                    : 'border-border dark:border-border-dark text-text-muted hover:text-text dark:hover:text-text-dark',
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ───────────────── 资产概览卡片 ───────────────── */

interface StatCardProps {
  label: string;
  icon: string;
  tone: 'income' | 'expense';
  amount: number;
  delta: number;
  expenseMode?: boolean;
  /** 看板顶栏"隐藏金额"开关：true 时用圆点占位金额 */
  hide?: boolean;
}

function StatCard({ label, icon, tone, amount, delta, expenseMode, hide }: StatCardProps) {
  const valueClass = tone === 'income' ? 'text-income' : 'text-expense';
  const sign = delta > 0 ? '+' : '';
  return (
    <Card className="!p-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-text-muted text-sm">
          <span>{icon}</span>
          <span>{label}</span>
        </div>
        <Badge tone={tone === 'income' ? 'income' : 'expense'}>
          <span className="inline-flex items-center gap-0.5">
            {delta > 0 && <IconArrowUpRight size={10} />}
            {delta < 0 && <IconArrowDownLeft size={10} />}
            {sign}
            {formatPercent(delta).replace(/^[+-]/, '')}
          </span>
        </Badge>
      </div>
      <div className={clsx('mt-3 text-2xl font-medium tabular-nums', valueClass)}>
        <MaskMoney value={amount} hide={!!hide} />
      </div>
      <div className="mt-1 text-xs text-text-muted">
        较上月 <span className={trendToneClass(delta, !!expenseMode)}>{formatPercent(delta)}</span>
      </div>
    </Card>
  );
}

/* ───────────────── 金额掩码组件 ───────────────── */

interface MaskMoneyProps {
  value: number;
  hide: boolean;
  withSymbol?: boolean;
  className?: string;
}

/**
 * 根据 hide 开关决定显示真实金额或圆点占位。
 *  - hide=true  时：渲染 "¥ ••••••"（与带符号的金额宽度相近，避免布局抖动）。
 *  - hide=false 时：走原有 formatMoney。
 */
function MaskMoney({ value, hide, withSymbol = true, className }: MaskMoneyProps) {
  if (hide) {
    return (
      <span className={className} aria-label="已隐藏金额">
        {withSymbol ? `${AMOUNT_HIDDEN_PREFIX}${AMOUNT_HIDDEN_BODY}` : AMOUNT_HIDDEN_BODY}
      </span>
    );
  }
  return <span className={className}>{formatMoney(value, withSymbol)}</span>;
}

/* ───────────────── 月历组件 ───────────────── */

interface MonthCalendarProps {
  month: dayjs.Dayjs;
  days: Array<{ date: dayjs.Dayjs; income: number; expense: number; count: number }>;
  onSelect: (day: dayjs.Dayjs) => void;
}

function MonthCalendar({ month, days, onSelect }: MonthCalendarProps) {
  const today = dayjs();
  const startWeekday = month.startOf('month').day(); // 0=Sun
  const cells: Array<{ date: dayjs.Dayjs | null; income: number; expense: number; count: number }> = [];

  for (let i = 0; i < startWeekday; i++) cells.push({ date: null, income: 0, expense: 0, count: 0 });
  for (const d of days) cells.push(d);

  // 行尾补齐（让最后一行显示为完整周）
  while (cells.length % 7 !== 0) cells.push({ date: null, income: 0, expense: 0, count: 0 });

  const hasAny = days.some((d) => d.income > 0 || d.expense > 0);

  return (
    <div>
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-text-muted mb-2">
        {['日', '一', '二', '三', '四', '五', '六'].map((w) => (
          <div key={w} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1">
        {cells.map((c, i) => {
          const day = c.date;
          if (!day) {
            return <div key={`empty-${i}`} className="h-16 rounded-lg" />;
          }
          const isToday = day.isSame(today, 'day');
          return (
            <button
              key={day.format('YYYY-MM-DD')}
              type="button"
              onClick={() => onSelect(day)}
              className={clsx(
                'h-16 rounded-lg border flex flex-col items-stretch justify-between p-1.5 text-left transition',
                isToday
                  ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-card-dark'
                  : 'border-transparent hover:bg-bg dark:hover:bg-bg-card-dark',
                c.count > 0 && 'cursor-pointer',
              )}
            >
              <div className="flex items-center justify-between">
                <span
                  className={clsx(
                    'text-xs tabular-nums',
                    isToday ? 'font-medium text-text dark:text-text-dark' : 'text-text-muted',
                  )}
                >
                  {day.date()}
                </span>
                {c.count > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-brand/70" />
                )}
              </div>
              <div className="flex flex-col gap-0.5 leading-tight">
                {c.income > 0 && (
                  <div className="text-[10px] text-income tabular-nums truncate">
                    +{formatMoney(c.income, false)}
                  </div>
                )}
                {c.expense > 0 && (
                  <div className="text-[10px] text-expense tabular-nums truncate">
                    -{formatMoney(c.expense, false)}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {!hasAny && (
        <div className="mt-4 text-center text-sm text-text-muted">暂无数据</div>
      )}
    </div>
  );
}