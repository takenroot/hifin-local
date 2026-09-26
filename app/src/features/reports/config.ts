/**
 * 报表自定义配置（config JSON）的元数据 / 类型 / 解析。
 *
 * config 字段是 JSON 字符串，包含：
 *   - range: 数据范围（本月 / 近 3 月 / 近 12 月 / 今年）
 *   - components: 展示组件勾选列表
 *
 * 仅供 reports 模块内部使用。
 */
import dayjs from 'dayjs';
import type { Transaction } from '@/db';

/** 数据范围枚举 */
export type ReportRangeKey = 'thisMonth' | 'last3Months' | 'last12Months' | 'thisYear';

export interface ReportRangeOption {
  key: ReportRangeKey;
  label: string;
}

export const REPORT_RANGE_OPTIONS: ReportRangeOption[] = [
  { key: 'thisMonth', label: '本月' },
  { key: 'last3Months', label: '近 3 月' },
  { key: 'last12Months', label: '近 12 月' },
  { key: 'thisYear', label: '今年' },
];

/** 展示组件枚举 */
export type ReportComponentKey =
  | 'incomeExpenseBar'
  | 'assetPie'
  | 'trendArea'
  | 'categoryRank';

export interface ReportComponentOption {
  key: ReportComponentKey;
  label: string;
  /** 简短描述 */
  description: string;
}

export const REPORT_COMPONENT_OPTIONS: ReportComponentOption[] = [
  {
    key: 'incomeExpenseBar',
    label: '收支柱状图',
    description: '按月统计收入与支出',
  },
  {
    key: 'assetPie',
    label: '资产分布环图',
    description: '展示账户/类型资产占比',
  },
  {
    key: 'trendArea',
    label: '趋势面积图',
    description: '结余随时间变化趋势',
  },
  {
    key: 'categoryRank',
    label: '分类排行表',
    description: '支出分类按金额降序',
  },
];

export interface ReportConfig {
  range: ReportRangeKey;
  components: ReportComponentKey[];
}

export const DEFAULT_REPORT_CONFIG: ReportConfig = {
  range: 'thisMonth',
  components: ['incomeExpenseBar'],
};

/** 安全解析 config 字符串；解析失败或字段缺失时返回默认值。 */
export function parseReportConfig(raw: string | undefined | null): ReportConfig {
  if (!raw) return { ...DEFAULT_REPORT_CONFIG };
  try {
    const obj = JSON.parse(raw) as Partial<ReportConfig>;
    const range = REPORT_RANGE_OPTIONS.some((o) => o.key === obj.range)
      ? (obj.range as ReportRangeKey)
      : DEFAULT_REPORT_CONFIG.range;
    const components = Array.isArray(obj.components)
      ? obj.components.filter((c): c is ReportComponentKey =>
          REPORT_COMPONENT_OPTIONS.some((o) => o.key === c),
        )
      : [];
    return {
      range,
      components:
        components.length > 0 ? components : DEFAULT_REPORT_CONFIG.components,
    };
  } catch {
    return { ...DEFAULT_REPORT_CONFIG };
  }
}

/** 根据 range key 计算时间窗口 [from, to)（毫秒时间戳，闭开区间）。 */
export function rangeBounds(key: ReportRangeKey): { from: number; to: number } {
  const now = dayjs();
  switch (key) {
    case 'thisMonth': {
      const start = now.startOf('month');
      return { from: start.valueOf(), to: now.add(1, 'day').startOf('day').valueOf() };
    }
    case 'last3Months': {
      const start = now.subtract(2, 'month').startOf('month');
      return { from: start.valueOf(), to: now.add(1, 'day').startOf('day').valueOf() };
    }
    case 'last12Months': {
      const start = now.subtract(11, 'month').startOf('month');
      return { from: start.valueOf(), to: now.add(1, 'day').startOf('day').valueOf() };
    }
    case 'thisYear': {
      const start = now.startOf('year');
      return { from: start.valueOf(), to: now.add(1, 'day').startOf('day').valueOf() };
    }
    default: {
      const start = now.startOf('month');
      return { from: start.valueOf(), to: now.add(1, 'day').startOf('day').valueOf() };
    }
  }
}

/** 按 range 过滤交易列表（仅保留 includeInAsset !== false 的收入/支出）。 */
export function filterTransactionsByRange(
  transactions: Transaction[],
  key: ReportRangeKey,
): Transaction[] {
  const { from, to } = rangeBounds(key);
  return transactions.filter(
    (t) =>
      t.date >= from &&
      t.date < to &&
      t.includeInAsset !== false &&
      (t.type === 'income' || t.type === 'expense'),
  );
}

/** 按 range 聚合月度收支（用于收支柱状图 / 趋势面积图）。 */
export interface RangeMonthlyDatum {
  key: string; // YYYY-MM
  label: string;
  income: number;
  expense: number;
  net: number;
}

export function monthlyByRange(
  transactions: Transaction[],
  key: ReportRangeKey,
): RangeMonthlyDatum[] {
  const now = dayjs();
  let monthsBack: number;
  let mode: 'calendar' | 'rolling';
  if (key === 'thisMonth') {
    monthsBack = 0;
    mode = 'calendar';
  } else if (key === 'last3Months') {
    monthsBack = 2;
    mode = 'rolling';
  } else if (key === 'last12Months') {
    monthsBack = 11;
    mode = 'rolling';
  } else {
    // thisYear
    monthsBack = now.month();
    mode = 'calendar';
  }

  const filtered = filterTransactionsByRange(transactions, key);
  const buckets = new Map<string, { income: number; expense: number }>();
  for (const t of filtered) {
    const k = dayjs(t.date).format('YYYY-MM');
    const b = buckets.get(k) ?? { income: 0, expense: 0 };
    if (t.type === 'income') b.income += t.amount;
    else if (t.type === 'expense') b.expense += t.amount;
    buckets.set(k, b);
  }

  const result: RangeMonthlyDatum[] = [];
  if (mode === 'calendar' && key === 'thisYear') {
    for (let i = 0; i <= monthsBack; i++) {
      const m = now.month(i).startOf('month');
      const k = m.format('YYYY-MM');
      const b = buckets.get(k) ?? { income: 0, expense: 0 };
      result.push({
        key: k,
        label: `${m.month() + 1}月`,
        income: b.income,
        expense: b.expense,
        net: b.income - b.expense,
      });
    }
    return result;
  }

  for (let i = monthsBack; i >= 0; i--) {
    const m = now.subtract(i, 'month').startOf('month');
    const k = m.format('YYYY-MM');
    const b = buckets.get(k) ?? { income: 0, expense: 0 };
    result.push({
      key: k,
      label: `${m.month() + 1}月`,
      income: b.income,
      expense: b.expense,
      net: b.income - b.expense,
    });
  }
  return result;
}

/** 按 range 聚合分类支出排行（用于分类排行表）。 */
export interface CategoryRankDatum {
  categoryId: number;
  /** "分组 · 分类名" 或 "未分类" */
  name: string;
  amount: number;
  pct: number;
}

export function categoryRankByRange(
  transactions: Transaction[],
  categories: Array<{ id?: number; name: string; group: string }>,
  key: ReportRangeKey,
): CategoryRankDatum[] {
  const filtered = filterTransactionsByRange(transactions, key).filter(
    (t) => t.type === 'expense',
  );
  const catMap = new Map<number, string>();
  for (const c of categories) {
    if (c.id != null) catMap.set(c.id, `${c.group} · ${c.name}`);
  }
  const buckets = new Map<number, number>();
  for (const t of filtered) {
    const cid = t.categoryId ?? -1;
    buckets.set(cid, (buckets.get(cid) ?? 0) + t.amount);
  }
  const total = Array.from(buckets.values()).reduce((s, v) => s + v, 0);
  return Array.from(buckets.entries())
    .map(([cid, amount]) => ({
      categoryId: cid,
      name: cid === -1 ? '未分类' : (catMap.get(cid) ?? '未知分类'),
      amount,
      pct: total > 0 ? (amount / total) * 100 : 0,
    }))
    .sort((a, b) => b.amount - a.amount);
}