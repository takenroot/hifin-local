/**
 * 统计视图（分类饼图 + 分类排行）
 * ---------------------------------------------------------------
 * 仿钱迹 / 一木记账的"统计"页通行设计：
 *   - 顶部：月份翻页器「‹ 2026年9月 ›」（未来月禁用）
 *   - 次行：支出 / 收入 pill 切换（默认支出）
 *   - 主体：左饼图（按分类占比） + 右排行（图标/名称/金额/占比/进度条，只读）
 *
 * 数据口径与计算全部委托给纯函数 stats.ts；本文件只做取数与渲染。
 * 月份走 atomWithStorage 持久化，刷新后仍停在上次查看的月份。
 */
import { useMemo, useState } from 'react';
import { useAtom } from 'jotai';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';
import clsx from 'clsx';
import { type Category, useSpaceId } from '@/db';
import { filterBySpace } from '@/space';
import { useApi } from '@/hooks/useApi';
import { EmptyStateCard, SegmentedControl } from '@/components/ui';
import { ChartTooltip } from '@/features/reports/chartTheme';
import { txStatsMonthAtom } from '@/store/atoms';
import { formatMoney } from './format';
import { PIE_COLORS } from '@/lib/format';
import { toTransaction, type RestTransaction } from './api';
import { CHART_ANIMATION_MS } from '@/lib/chartEasing';
import {
  STATS_TYPES,
  STATS_TYPE_LABELS,
  aggregateByCategory,
  currentMonth,
  isFutureMonth,
  parseMonth,
  shiftMonth,
  totalOf,
  type StatsType,
} from './stats';

interface Props {
  /** 父级写操作版本号：任一增删改后自增，驱动本视图重新拉取 */
  version?: number;
}

export function TransactionStatsView({ version = 0 }: Props) {
  const spaceId = useSpaceId();
  const spaceQ = spaceId === 0 ? '' : `?spaceId=${spaceId}`;

  const { data: txRows, loading } = useApi<RestTransaction[]>(`/api/transactions${spaceQ}`, [version]);
  const { data: categories } = useApi<Category[]>('/api/categories', [version]);

  const [persistedMonth, setMonth] = useAtom(txStatsMonthAtom);
  const [type, setType] = useState<StatsType>('expense');

  const transactions = useMemo(() => (txRows ?? []).map(toTransaction), [txRows]);
  const scopedTx = useMemo(() => filterBySpace(transactions, spaceId), [transactions, spaceId]);

  // 未来月钳制：localStorage 残留的远期月份不会让翻页器越界
  const month = useMemo(
    () => (isFutureMonth(persistedMonth) ? currentMonth() : parseMonth(persistedMonth).format('YYYY-MM')),
    [persistedMonth],
  );
  const atCurrentMonth = month >= currentMonth();
  const monthLabel = `${parseMonth(month).format('YYYY年M月')}`;

  const rows = useMemo(
    () => aggregateByCategory(scopedTx, month, type, categories ?? []),
    [scopedTx, month, type, categories],
  );
  const total = useMemo(() => totalOf(rows), [rows]);

  const pieData = useMemo(
    () => rows.map((r) => ({ name: r.name, value: r.amount })),
    [rows],
  );

  function step(delta: number) {
    const next = shiftMonth(month, delta);
    if (isFutureMonth(next)) return;
    setMonth(next);
  }

  // 数据还在路上：脉冲占位，避免每次进 Tab 闪一帧空态
  if (loading) {
    return (
      <div className="space-y-4" data-testid="stats-loading">
        <div className="h-10 rounded-xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
        <div className="h-72 rounded-2xl bg-bg-card dark:bg-bg-card-dark animate-pulse" />
      </div>
    );
  }

  return (
    <div className="space-y-5" data-testid="tx-stats">
      {/* 月份翻页器 + 收支切换 */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-1" data-testid="stats-month-nav">
          <button
            type="button"
            onClick={() => step(-1)}
            title="上一月"
            aria-label="上一月"
            data-testid="stats-prev-month"
            className="w-8 h-8 flex items-center justify-center rounded-lg text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark transition"
          >
            <IconChevronLeft size={16} />
          </button>
          <span
            className="min-w-[7.5rem] text-center text-sm font-medium text-text dark:text-text-dark tabular-nums"
            data-testid="stats-month-label"
          >
            {monthLabel}
          </span>
          <button
            type="button"
            onClick={() => step(1)}
            title="下一月"
            aria-label="下一月"
            data-testid="stats-next-month"
            disabled={atCurrentMonth}
            className={clsx(
              'w-8 h-8 flex items-center justify-center rounded-lg transition',
              'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
              atCurrentMonth && 'opacity-40 cursor-not-allowed hover:bg-transparent',
            )}
          >
            <IconChevronRight size={16} />
          </button>
        </div>

        <div data-testid="stats-type-toggle">
          <SegmentedControl
            aria-label="收支方向"
            value={type}
            onChange={setType}
            options={STATS_TYPES.map((t) => ({
              key: t,
              label: <span data-testid={`stats-type-${t}`}>{STATS_TYPE_LABELS[t]}</span>,
            }))}
          />
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyStateCard
          title={`${monthLabel}暂无${STATS_TYPE_LABELS[type]}记录`}
          description="换个月份看看，或先去记一笔账～"
          illustration={<ChartPieIllustration />}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-start">
          {/* 饼图 */}
          <div className="card !p-4" data-testid="stats-pie-card">
            <div className="flex items-center justify-between mb-2">
              <h3 className="section-title">{monthLabel} {STATS_TYPE_LABELS[type]}构成</h3>
              <span
                className={clsx(
                  'text-sm font-medium tabular-nums',
                  type === 'expense' ? 'text-expense' : 'text-income',
                )}
              >
                {formatMoney(total)}
              </span>
            </div>
            <div className="h-64" data-testid="stats-pie">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="55%"
                    outerRadius="85%"
                    paddingAngle={2}
                    animationDuration={CHART_ANIMATION_MS}
                    animationEasing="ease-out"
                  >
                    {pieData.map((_, i) => (
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
          </div>

          {/* 分类排行（只读，无下钻） */}
          <div className="card !p-4" data-testid="stats-rank-card">
            <h3 className="section-title mb-3">分类排行</h3>
            <ul className="space-y-3" data-testid="stats-rank">
              {rows.map((r, i) => (
                <li key={r.categoryId ?? `nc-${i}`} data-testid="stats-rank-item" className="space-y-1.5">
                  <div className="flex items-center gap-2 text-sm">
                    <span
                      className="w-2.5 h-2.5 rounded-sm flex-none"
                      style={{ background: PIE_COLORS[i % PIE_COLORS.length] }}
                    />
                    <span className="text-base flex-none leading-none">{r.icon ?? '📦'}</span>
                    <span className="flex-1 truncate text-text dark:text-text-dark">{r.name}</span>
                    <span
                      data-testid="stats-rank-pct"
                      className="tabular-nums text-text-muted dark:text-text-muted-dark text-xs"
                    >
                      {r.pct.toFixed(1)}%
                    </span>
                    <span
                      data-testid="stats-rank-amount"
                      className={clsx(
                        'tabular-nums font-medium w-24 text-right',
                        type === 'expense' ? 'text-expense' : 'text-income',
                      )}
                    >
                      {formatMoney(r.amount, false)}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-bg dark:bg-bg-card-dark overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, r.pct))}%`,
                        background: PIE_COLORS[i % PIE_COLORS.length],
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}

/** 空态插画：一张简化的环形图，与 EmptyState 默认插画同一套描边风格 */
function ChartPieIllustration() {
  return (
    <svg
      width="180"
      height="150"
      viewBox="0 0 180 150"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-border dark:text-border-dark"
      aria-hidden="true"
    >
      <circle cx="90" cy="75" r="52" stroke="currentColor" strokeWidth="1.8" opacity="0.5" strokeDasharray="2 5" />
      <circle cx="90" cy="75" r="40" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="90" cy="75" r="24" stroke="currentColor" strokeWidth="1.8" opacity="0.75" />
      <path d="M90 35 A40 40 0 0 1 128 91" stroke="currentColor" strokeWidth="6" strokeLinecap="round" opacity="0.45" />
      <path d="M90 75 m-7 0 a7 7 0 1 0 14 0 a7 7 0 1 0 -14 0" stroke="currentColor" strokeWidth="1.6" />
      <path d="M132 34 l16 -14 M140 20 h9 v9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.8" />
    </svg>
  );
}

export default TransactionStatsView;
