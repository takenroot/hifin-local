/**
 * 看板 Dashboard（功能完整版）
 * ---------------------------------------------------------------
 * 布局：左主右副（右侧栏约 280px）。
 * - 欢迎区：昵称（kv.nickname，默认"用户"）+ 按时段问候语 + 当前日期星期
 * - 资产概览三卡：净资产 / 本月收入 / 本月支出，带环比上月涨跌幅（绿涨红跌）
 *   三卡是「色块数据卡」（tailwind surface.stat）：软色底、无边框、圆角 3xl，
 *   净资产卡另加左侧 3px brand 边条标记主卡；金额升到 28px 半粗 tabular-nums。
 *   明暗对比度自查（探针口径，暗色底 = soft-dark 叠 #171a21）：
 *   金额红 #ef4444 3.85:1 / 绿 #10b981 5.04:1（28px 属大字号，门槛 3:1）；
 *   标签 #9ca3af 5.0:1 以上。亮色底 income.soft #fee2e2 上红字 3.08:1、
 *   expense.soft #d1fae5 上绿字 2.26:1 —— 与全站既有用法同量级
 *   （白卡上同为 3.76 / 2.56:1），不引入新的配色例外。
 * - 资产趋势：recharts 面积图，近 30 天净资产估算
 * - 资产分布：Tab（按账户/按交易方式）环形图
 * - 收支日历：可翻月的网格（‹ 2026年10月 › + 「今天」），每日收入/支出小计，
 *   点击弹当日流水列表。点月份文字另开「月份选择弹层」（年份翻页 + 3×4 网格）。
 *   月份是独立 state，不影响上方概览/趋势/分布的真实当月口径。
 * - 右侧栏：还款提醒 / 账户管理 / 目标管理 / 预算管理 / 最近交易
 *   预算管理读 /api/budgets，用看板已加载的流水按预算自身周期本地聚合「本期已花」
 *   （core 无 budget-spent 端点，/budget 页同源算法），超支走 danger 状态色。
 *
 * 暗黑模式约定：
 *   - 图表 Tooltip / 悬浮光标走 @/features/reports/chartTheme（recharts 默认写死 #fff）。
 *   - 弹窗内容自带前景色：Modal 是 portal，脱离 AppLayout 的 text-text 根节点。
 *   - 金额配色沿用色板约定：负数走 expense（绿），正数走 income（红）。
 *
 * ⚠️ 路由冲突说明：本模块 routes.tsx 中仍写 path: 'home'，
 *    与阶段 1 骨架 src/features/home/Dashboard.tsx 共用同一路径，
 *    集成阶段由 App.tsx 的 glob 收集决定保留哪一个。
 *    本文件**未修改** App.tsx 与 features/home。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
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
  IconChevronLeft,
  IconChevronRight,
  IconChevronDown,
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
  MonthPicker,
  Tabs,
  ProgressBar,
  PageHeader,
  AuroraBackground,
  BentoCard,
  EmptyStateCard,
} from '@/components/ui';
import { useSpaceId } from '@/db';
import type { Budget, Category, Goal } from '@/db';
import { useApi } from '@/hooks/useApi';
import { useAnimatedNumber } from '@/hooks/useAnimatedNumber';
import { toAccounts, toTransactions, type RestAccount, type RestTransaction } from '@/features/accounts/rest';
import { ChartTooltip, LINE_CURSOR } from '@/features/reports/chartTheme';

import {
  calcNetAsset,
  sumIncome,
  sumExpense,
  netAssetTrend,
  buildDistribution,
  buildCalendar,
  buildBudgetProgress,
  transactionsOnDay,
} from './calculations';
import {
  getWeatherSync,
  refreshWeather,
  clearWeatherCache,
  getSavedCity,
  saveCity,
  wmoToText,
  CITY_PRESETS,
  type CityPreset,
  type WeatherInfo,
} from './weather';
import {
  formatMoney,
  formatPercent,
  monthOverMonth,
  trendToneClass,
  balanceToneClass,
  greetingByHour,
  weekdayCn,
  monthLabelCn,
  earliestTransactionMonth,
} from './format';
import { PIE_COLORS } from '@/lib/format';

/* 隐藏金额时显示的占位字符（与币种符号宽度接近） */
const AMOUNT_HIDDEN_PREFIX = '¥ ';
const AMOUNT_HIDDEN_BODY = '******';

/* ───────────────── 卡片表面分层（与 tailwind surface.stat 同一契约） ─────────────────
 * stat  = 色块数据卡：软色底 + 无边框 + 圆角 3xl（白卡面板是 2xl，stat 更大一号）
 * panel = 既有白卡（index.css 的 .card），本模块其余卡片一律不动
 * 过渡只给背景色 160ms（--dur-surface），不做 hover 阴影。 */
const STAT_SURFACE =
  'rounded-3xl transition-[background-color_var(--dur-surface)_var(--ease-out)]';
const STAT_SURFACE_TONE = {
  brand: 'bg-surface-stat-brand dark:bg-surface-stat-brand-dark',
  income: 'bg-surface-stat-income dark:bg-surface-stat-income-dark',
  expense: 'bg-surface-stat-expense dark:bg-surface-stat-expense-dark',
} as const;
/** 主卡标记：左侧 3px brand 边条（绝对定位，不占布局宽度） */
const STAT_PRIMARY_BAR =
  "relative overflow-hidden before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand before:content-['']";

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

  // 天气（Open-Meteo）：stale-while-revalidate
  // 先用 getWeatherSync 画出缓存（超期也画，标记 isStale），再由 refreshWeather 静默回源替换，
  // 整个过程天气区域都不空白。失败时保留已渲染的内容。
  const [weather, setWeather] = useState<WeatherInfo | null>(null);
  const [weatherRefreshing, setWeatherRefreshing] = useState(false);
  const [cityModalOpen, setCityModalOpen] = useState(false);
  const [currentCity, setCurrentCity] = useState<string>('');
  const [cityQuery, setCityQuery] = useState('');
  const [cityCursor, setCityCursor] = useState(0);
  const cityListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    void getWeatherSync().then((cached) => {
      if (cancelled || !cached) return;
      setWeather(cached);
      setCurrentCity(cached.cityName);
    });
    void getSavedCity().then((c) => {
      if (!cancelled) setCurrentCity((prev) => prev || c.name);
    });
    setWeatherRefreshing(true);
    void refreshWeather().then((fresh) => {
      if (cancelled) return;
      if (fresh) {
        setWeather(fresh);
        setCurrentCity(fresh.cityName);
      }
      setWeatherRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 城市搜索（按名字过滤，66 个城市下必须可搜）
  const filteredCities = useMemo(() => {
    const q = cityQuery.trim();
    if (!q) return CITY_PRESETS;
    return CITY_PRESETS.filter((c) => c.name.includes(q));
  }, [cityQuery]);

  // 打开弹窗时重置搜索词与高亮游标
  useEffect(() => {
    if (!cityModalOpen) return;
    setCityQuery('');
    setCityCursor(0);
  }, [cityModalOpen]);

  // 键盘上下移动时把高亮项滚进可视区
  useEffect(() => {
    if (!cityModalOpen) return;
    const el = cityListRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [cityCursor, cityModalOpen, filteredCities]);

  /**
   * 切换城市：落盘 → 立即清缓存（新城市的坐标不同，旧缓存无意义）→ 强制回源。
   * 期间天气区显示城市名占位，不回退到上一个城市的读数。
   */
  const selectCity = useCallback(
    (city: CityPreset) => {
      setCurrentCity(city.name);
      setWeather(null);
      setCityModalOpen(false);
      setWeatherRefreshing(true);
      void (async () => {
        try {
          await saveCity(city);
          await clearWeatherCache();
        } catch {
          /* 落盘失败也继续回源 */
        }
        const fresh = await refreshWeather({ force: true });
        if (fresh) {
          setWeather(fresh);
          setCurrentCity(fresh.cityName);
        }
        setWeatherRefreshing(false);
      })();
    },
    [],
  );

  /** 城市列表键盘操作：↑/↓ 移动高亮，Enter 选中 */
  const onCityListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (filteredCities.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCityCursor((i) => (i + 1) % filteredCities.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCityCursor((i) => (i - 1 + filteredCities.length) % filteredCities.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const picked = filteredCities[cityCursor];
      if (picked) selectCity(picked);
    }
  };

  // 实时数据（REST）。空间过滤直接拼 URL：spaceId=0 表示"全部空间"，不带参数由后端返回全量。
  const spaceId = useSpaceId();
  const spaceQuery = spaceId ? `?spaceId=${spaceId}` : '';

  const accountsRes = useApi<RestAccount[]>(`/api/accounts${spaceQuery}`, [spaceId]);
  const transactionsRes = useApi<RestTransaction[]>(`/api/transactions${spaceQuery}`, [spaceId]);
  const goalsRes = useApi<Goal[]>(`/api/goals${spaceQuery}`, [spaceId]);
  const budgetsRes = useApi<Budget[]>(`/api/budgets${spaceQuery}`, [spaceId]);
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
  // 用 buildDistribution 而不是裸的 distributionBy*：多账户之后会出现负余额的
  // 资产账户（花呗还款把银行卡扣穿了），它们画不进饼图，必须把金额显式报出来，
  // 否则用户会发现饼图加起来和净资产对不上却找不到差额在哪。
  const dist = useMemo(() => buildDistribution(accounts, distTab), [distTab, accounts]);
  const distData = dist.items;
  const hasDistribution = distData.length > 0;

  /* 日历：月份独立 state
   * ---------------------------------------------------------------
   * 只有日历网格 + 点击日期弹层跟随 calendarMonth；顶部概览三卡、资产趋势、
   * 资产分布仍锚在真实当前月 currentMonth 上，互不影响。
   * 不持久化：看板是"落地即当下"的入口页，刷新永远回到当前月。
   */
  const [selectedDay, setSelectedDay] = useState<dayjs.Dayjs | null>(null);
  const [calendarMonth, setCalendarMonth] = useState<dayjs.Dayjs>(() => today.startOf('month'));

  // 下界 = 最早一笔日历可见交易所在月；空库时退回当前月（翻页器整体禁用到只留当前月）
  const calendarMinMonth = useMemo(
    () => earliestTransactionMonth(transactions) ?? currentMonth,
    [transactions, currentMonth],
  );
  const calendarAtMin = calendarMonth.isSame(calendarMinMonth, 'month');
  const calendarAtMax = calendarMonth.isSame(currentMonth, 'month');

  /** 翻月：越界（含边界）直接返回；每次成功翻页都清空当日弹层 */
  const stepCalendarMonth = useCallback(
    (delta: -1 | 1) => {
      const next = calendarMonth.add(delta, 'month').startOf('month');
      if (next.isAfter(currentMonth, 'month')) return; // 上界：未来月
      if (next.isBefore(calendarMinMonth, 'month')) return; // 下界：早于最早交易月
      setCalendarMonth(next);
      setSelectedDay(null);
    },
    [calendarMonth, currentMonth, calendarMinMonth],
  );

  /** 「今天」按钮：回到真实当前月 */
  const backToCurrentMonth = useCallback(() => {
    setCalendarMonth(currentMonth);
    setSelectedDay(null);
  }, [currentMonth]);

  /* 月份选择弹层：点月份文字打开，Esc / 点遮罩关闭由 Modal 负责。
   * 禁用判据与 ‹ › 翻页器同源（下界=最早交易月、上界=真实当前月），
   * 所以翻页器到不了的月份在弹层里同样是禁用的。
   * 唯一例外是空库：此时下界回退成当前月，翻页器被锁死在当前月，
   * 弹层里更早的月份仍可选（只是日历没有任何数据点）。 */
  const [monthPickerOpen, setMonthPickerOpen] = useState(false);

  /** 弹层里选中某月：落 calendarMonth + 清当日弹层 + 关闭选择器（与翻页器口径一致） */
  const pickCalendarMonth = useCallback((m: dayjs.Dayjs) => {
    setCalendarMonth(m.startOf('month'));
    setSelectedDay(null);
    setMonthPickerOpen(false);
  }, []);

  const calendarDays = useMemo(
    () => buildCalendar(transactions, calendarMonth),
    [transactions, calendarMonth],
  );
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

  /* 预算卡：读 /api/budgets，「本期已花」用看板已加载的流水本地聚合
   * （core 无 budget-spent 端点；算法见 calculations.buildBudgetProgress，与 /budget 页同源）。
   * 预算接口失败不进 loadError：一条预算读不到不该把整张看板换成错误页。 */
  const budgets = useMemo(() => budgetsRes.data ?? [], [budgetsRes.data]);
  const budgetProgress = useMemo(
    () => buildBudgetProgress(budgets, transactions, today.toDate()),
    [budgets, transactions, today],
  );
  const budgetsLoading = budgetsRes.loading && budgets.length === 0;

  return (
    <div className="relative min-h-full bg-bg dark:bg-bg-dark">
      {/* Aurora 氛围层：纯装饰，aria-hidden，绝不拦截指针（背景层规范 §1）。 */}
      <AuroraBackground />

      <PageHeader
        title="数据看板"
        icon={<IconLayoutDashboard size={18} />}
        actions={
          <div className="flex items-center gap-2 text-text-muted dark:text-text-muted-dark">
            <button
              type="button"
              onClick={() => setHideAmounts((v) => !v)}
              aria-pressed={hideAmounts}
              aria-label={hideAmounts ? '显示金额' : '隐藏金额'}
              title={hideAmounts ? '显示金额' : '隐藏金额'}
              className="inline-flex items-center justify-center rounded-md p-1 text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg-card dark:hover:bg-bg-card-dark transition-colors cursor-pointer"
            >
              {hideAmounts ? <IconEyeClosed size={18} /> : <IconEye size={18} />}
            </button>
          </div>
        }
      />

      <div className="p-4 lg:p-8">
        <div className="max-w-[1440px] mx-auto space-y-6">
          {loadError ? (
            <EmptyStateCard
              title="数据加载失败"
              description={`无法从服务端读取看板数据：${loadError}`}
            />
          ) : loading ? (
            <div className="space-y-6">
              <div className="h-24 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
              {/* 骨架用 stat 中性色块，与真卡同一形状（圆角 3xl），避免加载完成时"换形" */}
              <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
                <div className="xl:col-span-8 h-28 rounded-3xl bg-surface-stat dark:bg-surface-stat-dark animate-pulse" />
                <div className="xl:col-span-2 h-28 rounded-3xl bg-surface-stat dark:bg-surface-stat-dark animate-pulse" />
                <div className="xl:col-span-2 h-28 rounded-3xl bg-surface-stat dark:bg-surface-stat-dark animate-pulse" />
              </div>
              <div className="h-64 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
            </div>
          ) : (
          <>
            {/* 欢迎区（无 card 包裹，整块单列不参与 bento） */}
            <section>
              <div className="flex items-baseline gap-3">
                <div className="text-2xl font-medium">
                  你好，{nickname} 👋
                </div>
              </div>
              <div className="text-sm text-text-muted dark:text-text-muted-dark mt-1 flex items-center gap-2 flex-wrap">
                <span>
                  {greetingByHour(today.hour())}，今天是 {today.format('YYYY年MM月DD日')}，{weekdayCn(today)}
                </span>
                {/* 天气区：缓存（含超期）立即显示，回源成功后无感替换 —— 全程不空白 */}
                <span
                  className="inline-flex items-center gap-1 text-text-muted dark:text-text-muted-dark"
                  title={weather?.isStale ? '正在更新最新天气…' : undefined}
                  data-testid="weather-summary"
                >
                  <span aria-hidden>{weather ? wmoToText(weather.weathercode).icon : '🌡️'}</span>
                  {weather ? (
                    <>
                      <span>
                        {weather.cityName} {wmoToText(weather.weathercode).label}{' '}
                        {Math.round(weather.temperature)}°C
                      </span>
                      {weather.isStale && weatherRefreshing && (
                        <span className="text-[11px] opacity-70">更新中…</span>
                      )}
                    </>
                  ) : (
                    <span>
                      {currentCity || '本地'} --°C
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  onClick={() => setCityModalOpen(true)}
                  className="inline-flex items-center text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors"
                  title="切换城市"
                >
                  <IconSettings size={14} />
                </button>
              </div>
            </section>

            {/* bento 12 列网格（≥1280px 生效；以下单列堆叠）
                ponytail：delayStep 由调用方编排，本组件只把 step 折算成 ms；
                折线以上 7 张首屏 fade-up，折线以下 4 张靠 useInView 触发。 */}
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 xl:gap-4">
              {/* row 1：净资产 hero span 8 + 收入 span 2 + 支出 span 2 */}
              <BentoCard delayStep={0} className="xl:col-span-8">
                <div className="flex flex-col h-full">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-1.5">
                      <span aria-hidden>💰</span>净资产
                    </span>
                    <span className="text-[11px] text-text-muted dark:text-text-muted-dark">含负债抵消</span>
                  </div>
                  <div
                    className={clsx(
                      // 净资产 hero 是白/玻璃大卡 + 深数字 + 环比（规范 §3）
                      'mt-3 font-semibold tabular-nums tracking-[-0.02em]',
                      // clamp(40px, 5vw, 56px) — 设计 §2
                      'text-[clamp(40px,5vw,56px)] leading-[1.1]',
                      netAsset < 0 ? 'text-expense-deep dark:text-expense' : 'text-text dark:text-text-dark',
                    )}
                    data-testid="stat-net-asset-hero"
                  >
                    {hideAmounts ? <MaskMoney value={netAsset} hide /> : formatMoney(netAsset)}
                  </div>
                  <div className="mt-auto pt-4 flex items-baseline gap-1.5 text-xs">
                    <span className="text-text-muted dark:text-text-muted-dark">较上月</span>
                    <span
                      className={clsx(
                        'inline-flex items-center gap-0.5 font-medium',
                        netAssetMoM === 0
                          ? 'text-text-muted dark:text-text-muted-dark'
                          : trendToneClass(netAssetMoM, false),
                      )}
                    >
                      {netAssetMoM > 0 && <IconArrowUpRight size={12} />}
                      {netAssetMoM < 0 && <IconArrowDownLeft size={12} />}
                      {formatPercent(netAssetMoM)}
                    </span>
                  </div>
                </div>
              </BentoCard>
              <BentoCard delayStep={1} className="!bg-transparent !border-0 !shadow-none xl:col-span-2">
                <StatCard
                  label="本月收入"
                  icon="📥"
                  tone="income"
                  surface="income"
                  amount={monthIncome}
                  delta={incomeMoM}
                  hide={hideAmounts}
                  testId="stat-month-income"
                />
              </BentoCard>
              <BentoCard delayStep={2} className="!bg-transparent !border-0 !shadow-none xl:col-span-2">
                <StatCard
                  label="本月支出"
                  icon="📤"
                  tone="expense"
                  surface="expense"
                  amount={monthExpense}
                  delta={expenseMoM}
                  expenseMode
                  hide={hideAmounts}
                  testId="stat-month-expense"
                />
              </BentoCard>

              {/* row 2：资产趋势 span 8 + 资产分布 span 4 */}
              <BentoCard delayStep={3} className="!bg-transparent !border-0 !shadow-none xl:col-span-8">
                <Card flush title="资产趋势" extra={<span className="text-xs text-text-muted dark:text-text-muted-dark">近 30 天</span>}>
                  {hasTrend ? (
                    <div className="h-64 -mx-2">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={trendData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="dashNetGradient" x1="0" y1="0" x2="0" y2="1">
                              {/* ponytail: 资产趋势是净资产线（不是钱的方向），用 brand 炭黑与全站极简语言一致；软底渐变保深度即可 */}
                              <stop offset="0%" className="chart-brand" stopColor="currentColor" stopOpacity={0.4} />
                              <stop offset="100%" className="chart-brand" stopColor="currentColor" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border dark:text-border-dark" />
                          <XAxis
                            dataKey="date"
                            tick={{ fontSize: 11, fill: 'currentColor' }}
                            className="text-text-muted dark:text-text-muted-dark"
                            tickFormatter={(v: string) => dayjs(v).format('MM/DD')}
                            minTickGap={28}
                          />
                          <YAxis
                            tick={{ fontSize: 11, fill: 'currentColor' }}
                            className="text-text-muted dark:text-text-muted-dark"
                            width={60}
                            tickFormatter={(v: number) => {
                              if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(1)}万`;
                              return String(v);
                            }}
                          />
                          <Tooltip
                            content={<ChartTooltip />}
                            cursor={LINE_CURSOR}
                            formatter={(value: number | string) => [formatMoney(Number(value)), '净资产']}
                            labelFormatter={(label: string) => dayjs(label).format('YYYY-MM-DD')}
                          />
                          <Area
                            type="monotone"
                            dataKey="value"
                            stroke="currentColor"
                          className="chart-brand"
                            strokeWidth={2}
                            fill="url(#dashNetGradient)"
                            animationDuration={600}
                            animationEasing="ease-out"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>
                  ) : (
                    <EmptyState title="暂无数据" description="添加账户和交易后，这里会显示资产走势" />
                  )}
                </Card>
              </BentoCard>
              <BentoCard delayStep={4} className="!bg-transparent !border-0 !shadow-none xl:col-span-4">
                <Card
                  flush
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
                              animationDuration={600}
                              animationEasing="ease-out"
                            >
                              {distData.map((_, i) => (
                                <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                              ))}
                            </Pie>
                            <Tooltip
                              content={<ChartTooltip />}
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
                              <span className="text-text-muted dark:text-text-muted-dark tabular-nums">{pct.toFixed(1)}%</span>
                              <span className="font-medium tabular-nums w-24 text-right">
                                {formatMoney(d.value, false)}
                              </span>
                            </div>
                          );
                        })}

                        {/*
                         * 对账说明：饼图只画正余额的资产账户，负余额账户与负债账户
                         * 画不进去。多账户之后（花呗还款把银行卡扣成负数）这不再是个
                         * 理论问题，不说出来用户就会觉得"饼图和净资产对不上"。
                         */}
                        {(dist.excludedNegative < 0 || dist.excludedDebt !== 0) && (
                          <div className="pt-2 mt-2 border-t border-border dark:border-border-dark text-xs text-text-muted dark:text-text-muted-dark space-y-1">
                            {dist.excludedNegative < 0 && (
                              <div>
                                另有 {formatMoney(dist.excludedNegative)} 的账户余额为负，未计入上方占比
                              </div>
                            )}
                            {dist.excludedDebt !== 0 && (
                              <div>
                                负债账户合计 {formatMoney(dist.excludedDebt)}
                                （负值为实际欠款，正值为退款在途），不计入资产分布
                              </div>
                            )}
                          </div>
                        )}
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
              </BentoCard>

              {/* row 3：收支日历 span 6 + 最近交易 span 6
                  日历有 ‹› 翻页交互 → 关 lift（hover 抖动会让翻页按钮"飘"） */}
              <BentoCard delayStep={5} lift={false} className="!bg-transparent !border-0 !shadow-none xl:col-span-6">
                <Card
                  flush
                  title="收支日历"
                  extra={
                    <div className="flex items-center gap-1" data-testid="dash-calendar-nav">
                      <button
                        type="button"
                        onClick={() => stepCalendarMonth(-1)}
                        title="上一月"
                        aria-label="上一月"
                        data-testid="dash-calendar-prev"
                        disabled={calendarAtMin}
                        className={clsx(
                          'w-7 h-7 sm:w-8 sm:h-8 flex-none flex items-center justify-center rounded-lg transition',
                          'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                          calendarAtMin && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                        )}
                      >
                        <IconChevronLeft size={16} />
                      </button>
                      {/* 月份文字本身是选择器入口（‹ › 翻页器保持原样，另留一个按钮位） */}
                      <button
                        type="button"
                        onClick={() => setMonthPickerOpen(true)}
                        title="选择月份"
                        aria-label={`选择月份，当前 ${monthLabelCn(calendarMonth)}`}
                        aria-haspopup="dialog"
                        aria-expanded={monthPickerOpen}
                        data-testid="dash-calendar-label"
                        className="min-w-[4.75rem] sm:min-w-[7.5rem] -mx-1.5 px-1.5 inline-flex items-center justify-center gap-0.5 rounded-lg text-center text-xs sm:text-sm font-medium text-text dark:text-text-dark tabular-nums hover:bg-bg dark:hover:bg-bg-card-dark transition-colors cursor-pointer"
                      >
                        {monthLabelCn(calendarMonth)}
                        <IconChevronDown size={12} aria-hidden className="flex-none opacity-60" />
                      </button>
                      <button
                        type="button"
                        onClick={() => stepCalendarMonth(1)}
                        title="下一月"
                        aria-label="下一月"
                        data-testid="dash-calendar-next"
                        disabled={calendarAtMax}
                        className={clsx(
                          'w-7 h-7 sm:w-8 sm:h-8 flex-none flex items-center justify-center rounded-lg transition',
                          'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                          calendarAtMax && 'opacity-40 cursor-not-allowed hover:bg-transparent',
                        )}
                      >
                        <IconChevronRight size={16} />
                      </button>
                      {/* 仅在离开当前月时出现，避免常驻一个做不了事的按钮 */}
                      {!calendarAtMax && (
                        <button
                          type="button"
                          onClick={backToCurrentMonth}
                          title="回到当前月"
                          aria-label="回到当前月"
                          data-testid="dash-calendar-today"
                          className="ml-0.5 flex-none text-[11px] sm:text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors cursor-pointer"
                        >
                          今天
                        </button>
                      )}
                    </div>
                  }
                >
                  <div data-testid="dash-calendar">
                    <MonthCalendar
                      month={calendarMonth}
                      days={calendarDays}
                      onSelect={(d) => setSelectedDay(d)}
                    />
                  </div>
                </Card>
              </BentoCard>
              <BentoCard delayStep={6} className="!bg-transparent !border-0 !shadow-none xl:col-span-6">
                <Card
                  flush
                  title="最近交易"
                  extra={
                    recentTransactions.length > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/transaction')}
                        className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
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
                      className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition"
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
                          t.type === 'income' ? 'text-income' : t.type === 'expense' ? 'text-expense' : 'text-text-muted dark:text-text-muted-dark';
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
                              <div className="text-xs text-text-muted dark:text-text-muted-dark">
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
              </BentoCard>

              {/* row 4（折线以下 → inView 触发 fade-up）：右侧栏四卡折叠为 span 3×4 */}
              <BentoCard inView className="!bg-transparent !border-0 !shadow-none xl:col-span-3">
                <Card flush title="还款提醒">
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
                              <div className="text-xs text-text-muted dark:text-text-muted-dark">
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
              </BentoCard>
              <BentoCard inView className="!bg-transparent !border-0 !shadow-none xl:col-span-3">
                <Card
                  flush
                  title="账户管理"
                  extra={
                    accounts.length > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/account/list')}
                        className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
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
                      className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition"
                    >
                      <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                        <IconWallet size={18} />
                      </span>
                      <span>快捷添加首个账户</span>
                    </button>
                  ) : (
                    <div>
                      <div className="flex items-baseline justify-between">
                        <span className="text-xs text-text-muted dark:text-text-muted-dark">共 {accounts.length} 个账户</span>
                        <span className={clsx('tabular-nums font-medium', balanceToneClass(accountTotal))}>
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
              </BentoCard>
              <BentoCard inView className="!bg-transparent !border-0 !shadow-none xl:col-span-3">
                <Card
                  flush
                  title="目标管理"
                  extra={
                    goals.length > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/goal/list')}
                        className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
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
                      className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition"
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
                              <span className="text-xs text-text-muted dark:text-text-muted-dark ml-2 tabular-nums">
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
              </BentoCard>
              <BentoCard inView className="!bg-transparent !border-0 !shadow-none xl:col-span-3">
                <Card
                  flush
                  title="预算管理"
                  extra={
                    budgets.length > 0 && (
                      <button
                        type="button"
                        onClick={() => navigate('/budget')}
                        className="text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark inline-flex items-center gap-1"
                      >
                        详情 <IconArrowRight size={12} />
                      </button>
                    )
                  }
                >
                  {budgetsLoading ? (
                    <div className="space-y-3" data-testid="dash-budget-skeleton" aria-hidden>
                      {[0, 1].map((i) => (
                        <div key={i} className="h-8 rounded-lg bg-bg dark:bg-bg-card-dark animate-pulse" />
                      ))}
                    </div>
                  ) : budgetProgress.length === 0 ? (
                    <button
                      type="button"
                      onClick={() => navigate('/budget')}
                      data-testid="dash-budget-empty"
                      className="w-full flex flex-col items-center justify-center py-6 text-sm text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition"
                    >
                      <span className="w-10 h-10 rounded-full bg-bg dark:bg-bg-card-dark flex items-center justify-center mb-2">
                        <IconCircleDashed size={18} />
                      </span>
                      <span>设置本月预算</span>
                    </button>
                  ) : (
                    <div className="space-y-3" data-testid="dash-budget-list">
                      {budgetProgress.slice(0, 3).map(({ budget, spent, pct, overspent }) => (
                        <div key={budget.id} className="text-sm" data-testid="dash-budget-item">
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
                              {formatMoney(spent, false)} / {formatMoney(budget.amount, false)}
                            </span>
                          </div>
                          {/* 进度条配色沿用 /budget 页同一套语义：正常=支出绿，超支=收入红 */}
                          <ProgressBar
                            className="mt-1.5"
                            value={Math.max(0, Math.min(100, pct))}
                            tone={overspent ? 'income' : 'expense'}
                            size="sm"
                          />
                          {overspent && (
                            <div className="mt-1 text-[11px] text-danger dark:text-danger-dark">
                              已超支 {formatMoney(spent - budget.amount, false)}
                            </div>
                          )}
                        </div>
                      ))}
                      {budgetProgress.length > 3 && (
                        <div className="text-xs text-text-muted dark:text-text-muted-dark">
                          另有 {budgetProgress.length - 3} 个预算，见预算页
                        </div>
                      )}
                    </div>
                  )}
                </Card>
              </BentoCard>
            </div>
          </>
          )}
        </div>
      </div>

      {/* 月份选择弹层：点月份文字打开，Esc / 点遮罩关闭（通用 Modal 自带这两条） */}
      <Modal
        open={monthPickerOpen}
        onClose={() => setMonthPickerOpen(false)}
        title="选择月份"
        hideClose
        width={340}
      >
        <MonthPicker
          selected={calendarMonth}
          minMonth={calendarMinMonth}
          maxMonth={currentMonth}
          currentMonth={currentMonth}
          onSelect={pickCalendarMonth}
        />
      </Modal>

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
          // 根节点自带前景色：Modal 是 portal，文字不会继承 AppLayout 的 text-text
          <div className="divide-y divide-border dark:divide-border-dark -mx-2 text-text dark:text-text-dark">
            {dayTransactions.map((t) => {
              const cat = categories.find((c) => c.id === t.categoryId);
              const sign = t.type === 'income' ? '+' : t.type === 'expense' ? '-' : '';
              const tone =
                t.type === 'income'
                  ? 'text-income'
                  : t.type === 'expense'
                  ? 'text-expense'
                  : 'text-text-muted dark:text-text-muted-dark';
              return (
                <div key={t.id} className="flex items-center gap-3 px-2 py-3">
                  <span className="w-9 h-9 rounded-lg bg-bg dark:bg-bg-card-dark flex items-center justify-center text-lg flex-none">
                    {cat?.icon || (t.type === 'transfer' ? '🔁' : t.type === 'income' ? '💰' : '💸')}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm truncate text-text dark:text-text-dark">
                      {t.name || cat?.name || (t.type === 'transfer' ? '转账' : '未命名')}
                    </div>
                    <div className="text-xs text-text-muted dark:text-text-muted-dark flex items-center gap-2 mt-0.5">
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
        <div className="space-y-3 text-text dark:text-text-dark">
          <p className="text-xs text-text-muted dark:text-text-muted-dark">
            浏览器定位可用时优先使用当前位置；否则展示所选城市的天气。当前：
            <span className="text-text dark:text-text-dark font-medium">{currentCity || '未选择'}</span>
          </p>

          <input
            type="text"
            value={cityQuery}
            onChange={(e) => {
              setCityQuery(e.target.value);
              setCityCursor(0);
            }}
            placeholder="搜索城市，如“深”“杭州”"
            aria-label="搜索城市"
            data-testid="city-search"
            className="w-full rounded-xl border border-border dark:border-border-dark bg-bg dark:bg-bg-card-dark px-3 py-2 text-sm text-text dark:text-text-dark outline-none focus:border-text dark:focus:border-text-dark transition-colors placeholder:text-text-muted dark:placeholder:text-text-muted-dark"
          />

          <div
            ref={cityListRef}
            role="listbox"
            tabIndex={0}
            onKeyDown={onCityListKeyDown}
            data-testid="city-list"
            className="max-h-60 overflow-y-auto rounded-xl border border-border dark:border-border-dark p-1 outline-none focus:border-text dark:focus:border-text-dark"
          >
            {filteredCities.length === 0 ? (
              <div className="py-6 text-center text-sm text-text-muted dark:text-text-muted-dark">没有匹配的城市</div>
            ) : (
              filteredCities.map((c, i) => {
                const isCurrent = currentCity === c.name;
                const isCursor = i === cityCursor;
                return (
                  <button
                    key={c.name}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    data-active={isCursor ? 'true' : undefined}
                    onMouseEnter={() => setCityCursor(i)}
                    onClick={() => selectCity(c)}
                    className={clsx(
                      'w-full flex items-center justify-between rounded-lg px-3 py-2 text-sm text-left transition-colors cursor-pointer',
                      isCurrent
                        ? 'bg-text text-bg-card dark:bg-bg-card-dark dark:text-text-dark font-medium'
                        : 'text-text-muted dark:text-text-muted-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                      isCursor && !isCurrent && 'ring-1 ring-inset ring-border dark:ring-border-dark',
                    )}
                  >
                    <span>{c.name}</span>
                    {isCurrent && <span className="text-[11px] opacity-80">当前</span>}
                  </button>
                );
              })
            )}
          </div>

          <p className="text-[11px] text-text-muted dark:text-text-muted-dark">
            共 {CITY_PRESETS.length} 个城市
            {cityQuery.trim() ? `，匹配 ${filteredCities.length} 个` : ''}（↑/↓ 选择，Enter 确认）
          </p>
        </div>
      </Modal>
    </div>
  );
}

/* ───────────────── 资产概览卡片 ───────────────── */

interface StatCardProps {
  label: string;
  icon: string;
  /** 金额颜色：默认按 expenseMode 判断；传 'dynamic' 时按 delta 方向（涨红跌绿） */
  tone: 'income' | 'expense' | 'dynamic';
  /** 色块底色：跟随金额语义，主卡用 brand 标记层级 */
  surface: keyof typeof STAT_SURFACE_TONE;
  /** 主卡：加左侧 3px brand 边条 + 左侧留白 */
  primary?: boolean;
  amount: number;
  delta: number;
  expenseMode?: boolean;
  /** 看板顶栏"隐藏金额"开关：true 时用星号占位金额 */
  hide?: boolean;
  /** 验收脚本锚点（日历翻月脚本要断言"本月"口径不被日历月份带跑） */
  testId?: string;
}

/** 导出供渲染契约测试断言（金额主角化后的表面分层，tests/ui-stat-surface.test.ts） */
export function StatCard({
  label,
  icon,
  tone,
  surface,
  primary,
  amount,
  delta,
  expenseMode,
  hide,
  testId,
}: StatCardProps) {
  // dynamic：净资产专用——负数=坏事=红，正数=好事=绿（2026-10-06 起绿好红坏）；delta 辅助判断趋势
  const effectiveTone =
    tone === 'dynamic'
      ? amount < 0 || delta < 0
        ? 'expense'
        : 'income'
      : tone;
  // 色块卡上的大金额用 deep 变体（同色加深）：原色在 soft 底上对比度不足
  // （绿 2.24:1 不达 28px 大字号 3:1 门槛），deep 实测绿 4.84 / 红 3.95；
  // 暗色 soft-dark 底原色已达标（绿 5.09 / 红 3.81），保持原色
  const valueClass =
    effectiveTone === 'income'
      ? 'text-income-deep dark:text-income'
      : 'text-expense-deep dark:text-expense';
  // 环比：正=好事=绿、负=坏事=红（2026-10-06 统一口径；支出场景"减少"算好事，
  // 由 trendToneClass 的 expenseMode 处理），0 走 muted 并补 dark 变体，
  // 否则色块卡上会留下一行暗色模式对比度不足的深灰。
  const deltaTone =
    delta === 0
      ? 'text-text-muted dark:text-text-muted-dark'
      : trendToneClass(delta, !!expenseMode);
  // 滚动数字：隐藏时目标压到 0（反正渲染星号），取消隐藏即从 0 重滚到真实金额
  const animatedAmount = useAnimatedNumber(hide ? 0 : amount);
  return (
    <div
      className={clsx(
        STAT_SURFACE,
        STAT_SURFACE_TONE[surface],
        primary ? clsx(STAT_PRIMARY_BAR, 'p-5 pl-6') : 'p-5',
      )}
      data-testid={testId}
    >
      <div className="flex items-center gap-1.5 text-xs text-text-muted dark:text-text-muted-dark">
        <span aria-hidden>{icon}</span>
        <span>{label}</span>
      </div>
      <div className={clsx('mt-2 text-[28px] leading-tight font-semibold tabular-nums', valueClass)}>
        {hide ? <MaskMoney value={amount} hide /> : <span>{formatMoney(animatedAmount)}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5 text-xs">
        <span className="text-text-muted dark:text-text-muted-dark">较上月</span>
        <span className={clsx('inline-flex items-center gap-0.5 font-medium', deltaTone)}>
          {delta > 0 && <IconArrowUpRight size={12} />}
          {delta < 0 && <IconArrowDownLeft size={12} />}
          {formatPercent(delta)}
        </span>
      </div>
    </div>
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
 * 根据 hide 开关决定显示真实金额或星号占位。
 *  - hide=true  时：渲染 "¥ ******"（与带符号的金额宽度相近，避免布局抖动）。
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
      <div className="grid grid-cols-7 gap-1 text-center text-xs text-text-muted dark:text-text-muted-dark mb-2">
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
                    isToday ? 'font-medium text-text dark:text-text-dark' : 'text-text-muted dark:text-text-muted-dark',
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
                  <div className="text-[0.625rem] text-income tabular-nums truncate">
                    +{formatMoney(c.income, false)}
                  </div>
                )}
                {c.expense > 0 && (
                  <div className="text-[0.625rem] text-expense tabular-nums truncate">
                    -{formatMoney(c.expense, false)}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {!hasAny && (
        <div className="mt-4 text-center text-sm text-text-muted dark:text-text-muted-dark">暂无数据</div>
      )}
    </div>
  );
}