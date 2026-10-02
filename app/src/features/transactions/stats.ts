/**
 * 统计 Tab 的分类聚合（纯函数）
 * ---------------------------------------------------------------
 * 只依赖 @/db 的类型与 dayjs，不引入 React / UI 依赖，可直接单测。
 *
 * 口径说明：
 *  - 一次只算"某年某月 + 某收支方向"，月份区间取半开 [当月1日00:00, 次月1日00:00)。
 *  - 只统计 type === 参数指定的 'expense' | 'income'；transfer / excluded 天然被排除。
 *  - 「一级分类」= 本项目 categories 表里的分类实体（schema 是扁平一层，
 *    没有父子分类树，group 字段仅用于分类管理页的展示分组）。
 *  - 未挂分类的流水归入「未分类」（categoryId 为 undefined），单列一组。
 *  - pct = 该分类金额 / 当月同口径总额 * 100；不做四舍五入，因此所有分类
 *    pct 之和恒为 100（浮点误差量级 1e-13）。展示层再自行 toFixed(1)。
 *  - 金额为 0 的分类不进榜（对饼图无贡献），并按金额降序、同额按名称升序。
 */
import dayjs from 'dayjs';
import type { Category, Transaction, TransactionType } from '@/db';

/** 统计方向：支出 / 收入 */
export type StatsType = Extract<TransactionType, 'expense' | 'income'>;

export const STATS_TYPES: StatsType[] = ['expense', 'income'];

export const STATS_TYPE_LABELS: Record<StatsType, string> = {
  expense: '支出',
  income: '收入',
};

/** 未分类分组的展示名 / 兜底图标 */
export const UNCATEGORIZED_NAME = '未分类';
export const UNCATEGORIZED_ICON = '📦';

/** 一行分类统计 */
export interface CategoryStat {
  /** 分类 id；未分类为 undefined */
  categoryId?: number;
  /** 分类名称；未分类为「未分类」 */
  name: string;
  /** 分类 emoji 图标；无 / 未分类为 undefined */
  icon?: string;
  /** 该分类在此月此方向下的金额合计 */
  amount: number;
  /** 占当月同口径总额的比例（0 ~ 100，未做舍入，全量求和为 100） */
  pct: number;
}

/** 当月天数范围内的 [from, to) 时间戳（半开区间） */
export function monthBounds(month: string): { from: number; to: number } {
  const m = parseMonth(month);
  return { from: m.startOf('month').valueOf(), to: m.add(1, 'month').startOf('month').valueOf() };
}

/** 归一化 'YYYY-MM'；非法输入回落到当前月 */
export function parseMonth(month: string): dayjs.Dayjs {
  const m = /^(\d{4})-(\d{1,2})$/.exec(month);
  if (m) {
    const mo = Number(m[2]);
    // dayjs 对 '2026-13-01' 会静默进位成 2027-01，必须先手工卡月份范围
    if (mo >= 1 && mo <= 12) {
      const d = dayjs(`${m[1]}-${pad2(mo)}-01`);
      if (d.isValid()) return d;
    }
  }
  return dayjs().startOf('month');
}

/** 是否为合法的 'YYYY-MM' */
export function isValidMonth(month: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 'YYYY-MM' -> 可比较的数值（202609），用于翻页 / 未来月判断 */
export function monthNumber(month: string): number {
  const m = parseMonth(month);
  return m.year() * 100 + m.month() + 1;
}

/** 当前月 'YYYY-MM' */
export function currentMonth(): string {
  return dayjs().format('YYYY-MM');
}

/** 相对当前月的偏移（-1 上月 / +1 下月），结果仍是 'YYYY-MM' */
export function shiftMonth(month: string, delta: number): string {
  return parseMonth(month).add(delta, 'month').format('YYYY-MM');
}

/** 是否为未来月（严格晚于当前月） */
export function isFutureMonth(month: string): boolean {
  return monthNumber(month) > monthNumber(currentMonth());
}

/**
 * 按分类聚合指定月份、指定收支方向的金额。
 *
 * @param txs        参与聚合的流水（调用方需自行完成空间 / 筛选过滤）
 * @param month      'YYYY-MM'
 * @param type       'expense' | 'income'
 * @param categories 分类字典；用于补 name / icon，缺省时一律回落到「未分类」
 * @returns          按金额降序的分类统计
 */
export function aggregateByCategory(
  txs: Transaction[],
  month: string,
  type: StatsType,
  categories: Category[] = [],
): CategoryStat[] {
  const { from, to } = monthBounds(month);
  const catById = new Map<number, Category>();
  for (const c of categories) {
    if (c.id !== undefined) catById.set(c.id, c);
  }

  const acc = new Map<string, { categoryId?: number; name: string; icon?: string; amount: number }>();
  for (const t of txs) {
    if (t.type !== type) continue;
    if (t.date < from || t.date >= to) continue;

    const cat = t.categoryId !== undefined ? catById.get(t.categoryId) : undefined;
    const mapKey = cat?.id !== undefined ? `c${cat.id}` : 'none';
    const hit = acc.get(mapKey);
    if (hit) {
      hit.amount += t.amount;
    } else {
      acc.set(mapKey, {
        categoryId: cat?.id,
        name: cat?.name ?? UNCATEGORIZED_NAME,
        icon: cat?.icon,
        amount: t.amount,
      });
    }
  }

  const rows = Array.from(acc.values()).filter((r) => r.amount !== 0);
  const total = rows.reduce((s, r) => s + r.amount, 0);

  const result: CategoryStat[] = rows.map((r) => ({
    categoryId: r.categoryId,
    name: r.name,
    icon: r.icon,
    amount: r.amount,
    pct: total > 0 ? (r.amount / total) * 100 : 0,
  }));

  result.sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return result;
}

/** 当月同口径总额（饼图中心数值 / 空态判断都用它） */
export function totalOf(rows: CategoryStat[]): number {
  return rows.reduce((s, r) => s + r.amount, 0);
}
