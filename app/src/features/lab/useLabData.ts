/**
 * useLabData — 实验室统一数据源（2026-10-06）
 * ---------------------------------------------------------------
 * 一个开关（labRealDataAtom，持久化 hifin:labRealData）在两套同源数据间切换：
 *   - 静态样例：DashboardLab 的 mock 生成器（确定性、core 离线可用）
 *   - 真实数据：REST API（/api/summary + /api/transactions 12 个月窗口 +
 *     /api/accounts + /api/goals + /api/categories），映射口径见 labData.ts
 *
 * 失败语义：真实数据加载失败（core 离线/报错）时不阻断页面——保留 mock 渲染，
 * error 字符串交给开关组件显示（横幅上一条红字，一眼可辨）。
 * 加载语义：loading 期间保持旧数据显示（无骨架屏——实验室页不需要加载门控，
 * 数字跳变本身就是"换源"的反馈）。
 */
import { useEffect, useState } from 'react';
import { atomWithStorage } from 'jotai/utils';
import { useAtomValue } from 'jotai';
/** GET JSON：apiFetch 只封装写操作（POST/PUT/DELETE），读走裸 fetch */
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return (await r.json()) as T;
}
import {
  LAB_ANCHOR,
  LAB_STATS,
  LAB_SLICES,
  LAB_GOALS,
  LAB_RECENT_TX,
  LAB_SAVINGS_RATE,
  genLabTrend,
  genLabMonthly,
  genLabNetAssetSeries,
  genLabSavingsRateSeries,
  type LabMonthlyPoint,
} from './DashboardLab';
import {
  toMonthlyPoints,
  toDailyNetSeries,
  toNetAssetMonthlySeries,
  toSavingsRateSeries,
  toLabStats,
  toSlices,
  dateKeyOf,
  type TxRow,
  type AccountRow,
  type GoalRow,
  type SummaryRow,
} from './labData';

/** 真实数据开关（持久化）。false = 静态样例（默认，core 离线可开） */
export const labRealDataAtom = atomWithStorage<boolean>('hifin:labRealData', false);

export interface LabStat {
  label: string;
  amount: number;
  deltaPct: number;
}

export interface LabData {
  stats: { netAsset: LabStat; income: LabStat; expense: LabStat; savings: LabStat };
  /** 30 天日序列（{date, value}）——DashboardLab 趋势图 */
  trend30: Array<{ date: string; value: number }>;
  /** 12 个月净资产序列（sparkline） */
  netAssetMonthly: Array<{ month: string; value: number }>;
  savingsRateSeries: Array<{ month: string; value: number }>;
  monthly: LabMonthlyPoint[];
  slices: Array<{ name: string; value: number }>;
  goals: ReadonlyArray<{ name: string; current: number; target: number }>;
  recentTx: ReadonlyArray<{ date: string; name: string; category: string; account: string; amount: number }>;
}

/** mock 分支：与开关接入前两个页面各自 useMemo 的数据完全一致 */
function mockLabData(): LabData {
  const monthly = genLabMonthly(LAB_ANCHOR);
  return {
    stats: {
      netAsset: { label: LAB_STATS.netAsset.label, amount: LAB_STATS.netAsset.amount, deltaPct: LAB_STATS.netAsset.deltaPct },
      income: { label: LAB_STATS.income.label, amount: LAB_STATS.income.amount, deltaPct: LAB_STATS.income.deltaPct },
      expense: { label: LAB_STATS.expense.label, amount: LAB_STATS.expense.amount, deltaPct: LAB_STATS.expense.deltaPct },
      savings: { label: '储蓄率', amount: LAB_SAVINGS_RATE, deltaPct: 2.4 },
    },
    trend30: genLabTrend(LAB_ANCHOR),
    netAssetMonthly: genLabNetAssetSeries(LAB_ANCHOR),
    savingsRateSeries: genLabSavingsRateSeries(LAB_ANCHOR),
    monthly,
    slices: LAB_SLICES,
    goals: LAB_GOALS,
    recentTx: LAB_RECENT_TX.map((tx) => ({ ...tx })),
  };
}

interface CategoryRow {
  id?: number;
  name: string;
}

export interface LabDataState extends LabData {
  loading: boolean;
  /** 非 null = 真实数据加载失败（页面此时渲染的是 mock 兜底） */
  error: string | null;
}

export function useLabData(): LabDataState {
  const real = useAtomValue(labRealDataAtom);
  const [data, setData] = useState<LabData>(mockLabData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!real) {
      setData(mockLabData());
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const now = Date.now();
        const from = now - 396 * 24 * 60 * 60 * 1000; // 13 个月窗口，盖住 12 个月序列的边界月
        const [summary, txs, accounts, goals, categories] = await Promise.all([
          getJson<SummaryRow>('/api/summary'),
          getJson<TxRow[]>(`/api/transactions?from=${from}&to=${now}`),
          getJson<AccountRow[]>('/api/accounts'),
          getJson<GoalRow[]>('/api/goals'),
          getJson<CategoryRow[]>('/api/categories'),
        ]);
        if (cancelled) return;

        const monthly = toMonthlyPoints(txs, now);
        const catMap = new Map<number, string>(
          categories
            .map((c) => [Number(c.id), c.name] as [number, string])
            .filter(([id]) => Number.isFinite(id)),
        );
        const accMap = new Map<number, string>(
          accounts.map((a, i) => [Number((a as unknown as { id?: number }).id ?? i), a.name]),
        );
        setData({
          stats: (() => {
            const s = toLabStats(summary, monthly);
            return {
              netAsset: { label: '净资产', ...s.netAsset },
              income: { label: '本月收入', ...s.income },
              expense: { label: '本月支出', ...s.expense },
              savings: { label: '储蓄率', ...s.savings },
            };
          })(),
          trend30: toDailyNetSeries(txs, summary.netAsset, now),
          netAssetMonthly: toNetAssetMonthlySeries(monthly, summary.netAsset),
          savingsRateSeries: toSavingsRateSeries(monthly),
          monthly,
          slices: toSlices(accounts),
          goals: goals.map((g) => ({ name: g.name, current: g.currentAmount, target: g.targetAmount })),
          recentTx: txs.slice(0, 6).map((tx) => ({
            date: dateKeyOf(tx.date),
            name: tx.name,
            category: tx.categoryId != null ? (catMap.get(Number(tx.categoryId)) ?? '未分类') : '未分类',
            account: tx.accountId != null ? (accMap.get(Number(tx.accountId)) ?? '') : '',
            amount: tx.type === 'income' ? tx.amount : tx.type === 'expense' ? -tx.amount : 0,
          })),
        });
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [real]);

  return { ...data, loading, error };
}
