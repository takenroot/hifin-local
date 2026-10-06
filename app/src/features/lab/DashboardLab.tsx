/**
 * 视觉实验室 · 看板测试复刻（2026-10-06）
 * ---------------------------------------------------------------
 * 用途：UI 视觉想法的试验场。**看板（/home）的 1:1 视觉复刻 + 静态样例数据**，
 * 以后任何视觉想法（排版/色彩/动效/布局）先在这里试，对照 /home 截图评估，
 * 成熟了再动生产页面——避免再次出现「bento 全量落地后回退」的代价。
 *
 * 铁规：
 *  - 数据全部静态（下方 mock 生成器），**不发任何 API 请求**——core 不在线也能开
 *  - 视觉契约与 /home 对齐（surface.stat 软底卡 / panel 白卡 / income 绿 expense 红 /
 *    chart-brand 图表色），保证「对照实验」成立
 *  - 本页**不进 accept 回归闸的页面清单**（实验室允许有意违反规范来试效果）
 *  - 改动本页不需要回归脚本全绿，但 tsc + vitest 必须过
 *  - 想法沉淀后：要么合入生产（改 /home 并跑全套回归），要么连本页试验代码一起删
 */
import { useMemo } from 'react';
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
  const trend = useMemo(() => genLabTrend(), []);

  return (
    <div className="space-y-6" data-testid="dashboard-lab">
      {/* 实验室横幅：一眼认出这不是生产看板 */}
      <div className="flex items-center gap-2 rounded-xl border border-dashed border-border dark:border-border-dark px-4 py-2.5 text-xs text-text-muted dark:text-text-muted-dark">
        <IconFlask size={14} className="flex-none" />
        <span>
          视觉实验室 · 看板复刻 · 静态样例数据（不发 API）· 想法在此先验，成熟了再动 /home
        </span>
      </div>

      {/* 资产概览：复刻三卡色块带 */}
      <section>
        <h2 className="mb-3 text-sm font-medium text-text-muted dark:text-text-muted-dark">资产概览</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {/* 净资产主卡：brand 中性面 + 左 3px 边条 */}
          <div className={`${STAT_SURFACE} ${STAT_PRIMARY_BAR} bg-surface-stat dark:bg-surface-stat-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{LAB_STATS.netAsset.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-text dark:text-text-dark">
              ¥ {fmtMoney(LAB_STATS.netAsset.amount)}
            </div>
            <DeltaLine deltaPct={LAB_STATS.netAsset.deltaPct} />
          </div>
          {/* 收入：income soft 绿 */}
          <div className={`${STAT_SURFACE} bg-surface-stat-income dark:bg-surface-stat-income-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{LAB_STATS.income.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-income-deep dark:text-income">
              ¥ {fmtMoney(LAB_STATS.income.amount)}
            </div>
            <DeltaLine deltaPct={LAB_STATS.income.deltaPct} />
          </div>
          {/* 支出：expense soft 红 */}
          <div className={`${STAT_SURFACE} bg-surface-stat-expense dark:bg-surface-stat-expense-dark p-5`}>
            <div className="text-xs text-text-muted dark:text-text-muted-dark">{LAB_STATS.expense.label}</div>
            <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight text-expense-deep dark:text-expense">
              ¥ {fmtMoney(LAB_STATS.expense.amount)}
            </div>
            <DeltaLine deltaPct={LAB_STATS.expense.deltaPct} invert />
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
                animationDuration={600}
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
                  data={LAB_SLICES}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  animationDuration={600}
                  animationEasing="ease-out"
                >
                  {LAB_SLICES.map((_, i) => (
                    <Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v) => `¥ ${fmtMoney(Number(v))}`} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <ul className="w-full space-y-2 text-sm md:w-1/2">
            {LAB_SLICES.map((s, i) => (
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
  );
}

export default DashboardLab;
