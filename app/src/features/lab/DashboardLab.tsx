/**
 * 视觉实验室 · 看板测试复刻（2026-10-06）
 * ---------------------------------------------------------------
 * 用途：UI 视觉想法的试验场。**看板（/home）的 1:1 视觉复刻 + 静态样例数据**，
 * 以后任何视觉想法（排版/色彩/动效/布局）先在这里试，对照 /home 截图评估，
 * 成熟了再动生产页面——避免再次出现「bento 全量落地后回退」的代价。
 *
 * 铁规：
 *  - 数据默认静态（下方 mock 生成器），横幅开关可切真实数据（REST）——见 useLabData.ts
 *  - 视觉契约与 /home 对齐（surface.stat 软底卡 / panel 白卡 / income 绿 expense 红 /
 *    chart-brand 图表色），保证「对照实验」成立
 *  - 本页**不进 accept 回归闸的页面清单**（实验室允许有意违反规范来试效果）
 *  - 改动本页不需要回归脚本全绿，但 tsc + vitest 必须过
 *  - 想法沉淀后：要么合入生产（改 /home 并跑全套回归），要么连本页试验代码一起删
 */
import { useLabData } from './useLabData';
import { LabDataSwitch } from './LabDataSwitch';
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  Tooltip,
} from 'recharts';
import { IconFlask } from '@tabler/icons-react';
import { PIE_COLORS } from '@/lib/format';

/* ───────────────────────── 静态样例数据（确定性生成，可测） ───────────────────────── */

export interface LabTrendPoint {
  /** YYYY-MM-DD */
  date: string;
  value: number;
}

/** 锚定末日，保证任何时间打开页面看到的都是同一组数据（对照实验前提） */
export const LAB_ANCHOR = '2026-10-06';

/** 往前推 n 天的 YYYY-MM-DD（本地时区，无外部依赖） */
export function dateBefore(anchor: string, daysBack: number): string {
  const d = new Date(`${anchor}T00:00:00`);
  d.setDate(d.getDate() - daysBack);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * 30 天净资产趋势样例：基线缓升 + 周期波动 + 周末小低谷。
 * 纯公式无随机源，同一天任何时刻调用结果一致（测试可断言具体值）。
 */
export function genLabTrend(anchor: string = LAB_ANCHOR, days = 30): LabTrendPoint[] {
  const out: LabTrendPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = days - 1 - i; // 0..29，越早越小
    const weekday = new Date(`${dateBefore(anchor, i)}T00:00:00`).getDay();
    const weekendDip = weekday === 0 || weekday === 6 ? -1400 : 0;
    const value = Math.round(35500 + t * 52 + Math.sin(t / 3.2) * 780 + weekendDip);
    out.push({ date: dateBefore(anchor, i), value });
  }
  return out;
}

export interface LabSlice {
  name: string;
  value: number;
}

/** 资产分布样例（与真实账户同构的四种典型形态） */
export const LAB_SLICES: LabSlice[] = [
  { name: '零钱通', value: 27957.4 },
  { name: '支付宝基金', value: 9075.85 },
  { name: '现金', value: 1200 },
  { name: '工行卡(1230)', value: 5360 },
];

/** 三卡样例：好事=绿（income）/ 坏事=红（expense），与生产口径一致 */
export const LAB_STATS = {
  netAsset: { label: '净资产', amount: 37593.25, deltaPct: -1.47, tone: 'expense' as const },
  income: { label: '本月收入', amount: 12480.0, deltaPct: 8.2, tone: 'income' as const },
  expense: { label: '本月支出', amount: 8230.5, deltaPct: -3.1, tone: 'income' as const },
};

/* ───────────────────────── Zenith 变体扩展（2026-10-06） ─────────────────────────
 * 静态确定性扩展，与上面 LAB_STATS 共用 LAB_ANCHOR，保证两个实验页可对照：
 *   - genLabMonthly：12 个月收支结余序列，末月恰好 = LAB_STATS.income / .expense
 *   - LAB_GOALS    ：3 条目标进度样例
 *   - LAB_RECENT_TX：6 条最近交易样例（支出=负 / 收入=正）
 * ponytail：数据生成器集中放在 DashboardLab.tsx，避免 ZenithLab 自带 mock
 * 形成第二份真相；后续 DashboardLab 删除时一起处理。 */

/** 单月收支结余点：定义已上移至 @/lib/monthlyAgg；本地 import + re-export 保持既有路径 */
import type { LabMonthlyPoint } from '@/lib/monthlyAgg';
import { CHART_ANIMATION_MS } from '@/lib/chartEasing';
export type { LabMonthlyPoint };

/** 把 YYYY-MM-DD 锚点归到当月 1 号再回退 i 个月，得到 YYYY-MM */
function monthBefore(anchor: string, monthsBack: number): string {
  const d = new Date(`${anchor}T00:00:00`);
  d.setDate(1);
  d.setMonth(d.getMonth() - monthsBack);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 12 个月收支结余序列：纯正弦 + 月度微调，末月固定为 LAB_STATS.income / .expense。
 * ponytail：确定性公式 + 末月对齐 LAB_STATS，保证 Overview 面积图与三卡数字
 * 自洽（"本月收入"卡片显示的数字 = 序列末月的 income 字段）。
 */
export function genLabMonthly(anchor: string = LAB_ANCHOR): LabMonthlyPoint[] {
  const out: LabMonthlyPoint[] = [];
  for (let i = 0; i < 12; i++) {
    const m = monthBefore(anchor, 11 - i); // i=0 → 11 月前；i=11 → 锚定月
    // 前 11 月：基线 + 季节正弦 + 小数偏移；末月：严格等于 LAB_STATS
    const income = i === 11
      ? LAB_STATS.income.amount
      : Math.round(11800 + Math.sin((i + 1) / 2.3) * 820 + ((i + 1) % 3 === 0 ? -580 : 60));
    const expense = i === 11
      ? LAB_STATS.expense.amount
      : Math.round(7980 + Math.sin((i + 1) / 1.7) * 540 + ((i + 2) % 4 === 0 ? 320 : -120));
    out.push({ month: m, income, expense, balance: income - expense });
  }
  return out;
}

/** 净资产时间序列：把 monthly balance 累加成"到当月为止的净资产"，末值等于 LAB_STATS.netAsset。
 *  ponytail：用 O(12) 一次累加而不是 12 次函数调用——测试断言的是末值自洽，
 *  不是中间过程，所以直接补差填到 LAB_STATS.netAsset 即可。 */
export function genLabNetAssetSeries(anchor: string = LAB_ANCHOR): Array<{ month: string; value: number }> {
  const monthly = genLabMonthly(anchor);
  const sumBalances = monthly.reduce((acc, p) => acc + p.balance, 0);
  const start = LAB_STATS.netAsset.amount - sumBalances;
  let running = start;
  return monthly.map((p) => {
    running += p.balance;
    return { month: p.month, value: Math.round(running * 100) / 100 };
  });
}

/** 储蓄率时间序列：(income - expense) / income * 100，0..100 百分比。 */
export function genLabSavingsRateSeries(anchor: string = LAB_ANCHOR): Array<{ month: string; value: number }> {
  return genLabMonthly(anchor).map((p) => ({
    month: p.month,
    value: p.income > 0 ? Math.round(((p.income - p.expense) / p.income) * 10000) / 100 : 0,
  }));
}

/** 3 条目标进度样例：当前/目标，渲染时计算百分比 */
export const LAB_GOALS: ReadonlyArray<{ name: string; current: number; target: number }> = [
  { name: '应急基金', current: 18500, target: 30000 },
  { name: '旅行储蓄', current: 4200, target: 10000 },
  { name: '装修预算', current: 32000, target: 50000 },
];

/** 6 条最近交易样例：amount > 0 收入（绿）/ < 0 支出（红） */
export interface LabRecentTx {
  date: string;
  name: string;
  category: string;
  account: string;
  amount: number;
}

export const LAB_RECENT_TX: ReadonlyArray<LabRecentTx> = [
  { date: '2026-10-06', name: '午餐外卖', category: '餐饮', account: '零钱通', amount: -38.5 },
  { date: '2026-10-05', name: '工资到账', category: '收入', account: '工行卡(1230)', amount: 6200 },
  { date: '2026-10-04', name: '超市采购', category: '日用', account: '支付宝基金', amount: -186.4 },
  { date: '2026-10-03', name: '打车通勤', category: '交通', account: '零钱通', amount: -45.0 },
  { date: '2026-10-02', name: '咖啡', category: '餐饮', account: '零钱通', amount: -28.0 },
  { date: '2026-10-01', name: '基金分红', category: '投资', account: '支付宝基金', amount: 320.0 },
];

/** 当前月份（"本月"）的储蓄率：与 Zenith 第四卡数字一致 */
export const LAB_SAVINGS_RATE = (() => {
  const last = genLabMonthly()[11];
  return Math.round(((last.income - last.expense) / last.income) * 10000) / 100;
})();

/* ───────────────────────── 复刻 /home 的卡片表面契约 ───────────────────────── */

/** 与 Dashboard.tsx STAT_SURFACE 同源：软色底、无边框、圆角 3xl */
const STAT_SURFACE =
  'rounded-3xl transition-[background-color_var(--dur-surface)_var(--ease-out)]';
const STAT_PRIMARY_BAR =
  "relative overflow-hidden before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-brand before:content-['']";

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function DeltaLine({ deltaPct, invert = false }: { deltaPct: number; invert?: boolean }) {
  // 口径与生产 trendToneClass(delta, expenseMode) 一致：支出场景"减少"算好事，
  // 所以方向要先经 invert 翻转再判好坏；箭头跟数值符号走
  const good = invert ? deltaPct < 0 : deltaPct > 0;
  const arrow = deltaPct > 0 ? '↑' : '↓';
  return (
    <div className="mt-1 text-xs text-text-muted dark:text-text-muted-dark">
      较上月{' '}
      <span className={good ? 'text-income' : 'text-expense'}>
        {arrow} {Math.abs(deltaPct).toFixed(2)}%
      </span>
    </div>
  );
}

/* ───────────────────────── 页面 ───────────────────────── */

export function DashboardLab() {
  // 统一数据源：静态样例 ↔ 真实数据（横幅开关切换，见 useLabData）
  const lab = useLabData();
  const trend = lab.trend30;

  return (
    <div className="p-4 lg:p-8">
      {/* 页面骨架与生产契约对齐：p-4 lg:p-8 沟槽 + max-w-[1400px] 居中
         （原裸 space-y-6 导致内容贴 rail/视口边缘——web-design-guidelines 审查项） */}
      <div className="max-w-[1400px] mx-auto space-y-6" data-testid="dashboard-lab">
      {/* 实验室横幅：一眼认出这不是生产看板；右侧数据源开关 */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-border dark:border-border-dark px-4 py-2.5 text-xs text-text-muted dark:text-text-muted-dark">
        <span className="flex items-center gap-2 min-w-0">
          <IconFlask size={14} className="flex-none" />
          <span className="truncate">
            视觉实验室 · 看板复刻 · 想法在此先验，成熟了再动 /home
          </span>
        </span>
        <LabDataSwitch error={lab.error} />
      </div>

      {/* 资产概览：复刻三卡色块带 */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-text-muted dark:text-text-muted-dark">资产概览</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* 净资产主卡：brand 中性面 + 左 3px 边条 */}
          <div className={`${STAT_SURFACE} ${STAT_PRIMARY_BAR} bg-surface-stat dark:bg-surface-stat-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{lab.stats.netAsset.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
              ¥ {fmtMoney(lab.stats.netAsset.amount)}
            </div>
            <DeltaLine deltaPct={lab.stats.netAsset.deltaPct} />
          </div>
          {/* 收入：income soft 绿 */}
          <div className={`${STAT_SURFACE} bg-surface-stat-income dark:bg-surface-stat-income-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{lab.stats.income.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-income-deep dark:text-income">
              ¥ {fmtMoney(lab.stats.income.amount)}
            </div>
            <DeltaLine deltaPct={lab.stats.income.deltaPct} />
          </div>
          {/* 支出：expense soft 红 */}
          <div className={`${STAT_SURFACE} bg-surface-stat-expense dark:bg-surface-stat-expense-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{lab.stats.expense.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-expense-deep dark:text-expense">
              ¥ {fmtMoney(lab.stats.expense.amount)}
            </div>
            <DeltaLine deltaPct={lab.stats.expense.deltaPct} invert />
          </div>
        </div>
      </section>

      {/* 资产趋势：复刻 panel 白卡 + chart-brand 炭黑线（currentColor 暗色反转） */}
      <section className="card p-5">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium">资产趋势</h2>
          <span className="text-xs text-text-muted dark:text-text-muted-dark">近 30 天</span>
        </div>
        <div className="h-64 -mx-2">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={trend} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="labTrendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" className="chart-brand" stopColor="currentColor" stopOpacity={0.4} />
                  <stop offset="100%" className="chart-brand" stopColor="currentColor" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="currentColor" className="text-border dark:text-border-dark" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted dark:text-text-muted-dark"
                tickFormatter={(v: string) => v.slice(5).replace('-', '/')}
                minTickGap={28}
              />
              <YAxis
                tick={{ fontSize: 11, fill: 'currentColor' }}
                className="text-text-muted dark:text-text-muted-dark"
                width={60}
                tickFormatter={(v: number) => (Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}万` : String(v))}
              />
              <Tooltip
                formatter={(v) => [`¥ ${fmtMoney(Number(v))}`, '净资产']}
                labelStyle={{ fontSize: 12 }}
                contentStyle={{ borderRadius: 12, fontSize: 12 }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="currentColor"
                className="chart-brand"
                strokeWidth={2}
                fill="url(#labTrendGradient)"
                animationDuration={CHART_ANIMATION_MS}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      {/* 资产分布：复刻 donut + PIE_COLORS 调色板 */}
      <section className="card p-5">
        <h2 className="mb-3 text-sm font-medium">资产分布</h2>
        <div className="flex flex-col items-center gap-6 md:flex-row">
          <div className="h-56 w-full md:w-1/2">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={lab.slices}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  animationDuration={CHART_ANIMATION_MS}
                  animationEasing="ease-out"
                >
                  {lab.slices.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => `¥ ${fmtMoney(Number(v))}`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="w-full space-y-2 text-sm md:w-1/2">
            {lab.slices.map((s, i) => (
              <li key={s.name} className="flex items-center gap-2">
                <span
                  className="h-2.5 w-2.5 rounded-sm flex-none"
                  style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                />
                <span className="flex-1 truncate">{s.name}</span>
                <span className="tabular-nums text-text-muted dark:text-text-muted-dark">
                  ¥ {fmtMoney(s.value)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
      </div>
    </div>
  );
}

export default DashboardLab;
