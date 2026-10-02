/**
 * 流水分组（日 / 周 / 月 / 年）+ 周期小计
 * ---------------------------------------------------------------
 * 纯函数模块：只依赖 @/db 的类型与 dayjs，不引入任何 React / UI 依赖，
 * 因此可以直接被单测覆盖（见 tests/grouping.test.ts）。
 *
 * 约定：
 *  - 周起始 = 周一（ISO-8601），周编号 / 周所属年份按 ISO 规则算：
 *    周四所在的年份就是该周的"周所属年份"，含 1 月 4 日的那周是第 1 周。
 *    例：2026-09-21(周一) ~ 2026-09-27(周日) = 2026 年第 39 周。
 *  - 每组按"周期起始时间"倒序（最新的周期在最上面）；日档额外把
 *    「今天 / 昨天」顶到最前，与既有列表行为保持一致。
 *  - 小计只累计 income / expense；transfer 与 excluded 不计入任何一侧。
 *    （与 summarize() 同口径。）
 */
import dayjs from 'dayjs';
import type { Transaction } from '@/db';

/** 分组维度：日 / 周 / 月 / 年 */
export type GroupDim = 'day' | 'week' | 'month' | 'year';

export const GROUP_DIMS: GroupDim[] = ['day', 'week', 'month', 'year'];

/** 分组维度 -> 中文档位名（分段控件用） */
export const GROUP_DIM_LABELS: Record<GroupDim, string> = {
  day: '日',
  week: '周',
  month: '月',
  year: '年',
};

/** 一个分组：标题 + 该周期的收支小计 + 明细 */
export interface TxGroup {
  /** 稳定唯一 key（跨渲染不变，可直接做 React key / 测试断言） */
  key: string;
  /** 展示标题，不含小计；小计由视图层按维度决定是否拼接 */
  label: string;
  /** 该周期内全部 expense 金额之和 */
  subExpense: number;
  /** 该周期内全部 income 金额之和 */
  subIncome: number;
  /** 组内明细，保持传入顺序 */
  txs: Transaction[];
  /** 周期起始时间戳（今天/昨天 档为当天 0 点） */
  start: number;
}

/**
 * ISO-8601 周编号。
 * 返回周所属年份 + 第几周；周一为一周之始。
 */
export function isoWeekOf(date: dayjs.Dayjs): { year: number; week: number } {
  // 周一=1 … 周日=7（dayjs 的 day() 里周日是 0，先归一）
  const dow = date.day() === 0 ? 7 : date.day();
  // 该周周四：ISO 规则下周四所在年份即周所属年份
  const thursday = date.startOf('day').add(4 - dow, 'day');
  const year = thursday.year();
  const jan4 = dayjs(`${year}-01-04`);
  const jan4Dow = jan4.day() === 0 ? 7 : jan4.day();
  // 当年第一个周四 = 当年第 1 周的周四
  const firstThursday = jan4.add(4 - jan4Dow, 'day');
  const week = Math.round(thursday.diff(firstThursday, 'day') / 7) + 1;
  return { year, week };
}

/** 该时间戳所在 ISO 周的 [周一 00:00, 下周一 00:00) */
export function isoWeekRange(date: dayjs.Dayjs): { start: number; end: number } {
  const dow = date.day() === 0 ? 7 : date.day();
  const monday = date.startOf('day').subtract(dow - 1, 'day');
  return { start: monday.valueOf(), end: monday.add(7, 'day').valueOf() };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 日档标题：今天 / 昨天 / 2026年9月27日 Sun（与既有列表完全一致） */
function dayLabel(d: dayjs.Dayjs, today: dayjs.Dayjs): string {
  const t = today.startOf('day');
  if (d.isSame(t)) return '今天';
  if (d.isSame(t.subtract(1, 'day'))) return '昨天';
  return d.format('YYYY年M月D日 ddd');
}

/** 内部：把一笔交易映射到 (key, label, start) */
function bucketOf(
  d: dayjs.Dayjs,
  dim: GroupDim,
  today: dayjs.Dayjs,
): { key: string; label: string; start: number } {
  switch (dim) {
    case 'day': {
      const start = d.startOf('day');
      return { key: `d-${d.format('YYYY-MM-DD')}`, label: dayLabel(start, today), start: start.valueOf() };
    }
    case 'week': {
      const { start } = isoWeekRange(d);
      const monday = dayjs(start);
      const sunday = monday.add(6, 'day');
      const { year, week } = isoWeekOf(d);
      return {
        key: `w-${year}-${pad2(week)}`,
        label: `${year}年第${week}周（${monday.format('M.D')}-${sunday.format('M.D')}）`,
        start,
      };
    }
    case 'month': {
      const s = d.startOf('month');
      return {
        key: `m-${s.format('YYYY-MM')}`,
        label: `${s.format('YYYY年M月')}`,
        start: s.valueOf(),
      };
    }
    case 'year': {
      const s = d.startOf('year');
      return {
        key: `y-${s.format('YYYY')}`,
        label: `${s.format('YYYY年')}`,
        start: s.valueOf(),
      };
    }
  }
}

/**
 * 把流水按维度分组，并带上每个周期的收支小计。
 *
 * @param txs   流水列表（顺序不敏感；组内保持传入顺序）
 * @param dim   分组维度
 * @param today 参照"今天"（仅日档的 今天/昨天 文案用到；默认取当前时间）
 * @returns     按周期倒序的分组数组
 */
export function groupTransactions(
  txs: Transaction[],
  dim: GroupDim,
  today: dayjs.Dayjs = dayjs(),
): TxGroup[] {
  const ref = dayjs(today);
  const byKey = new Map<string, TxGroup>();

  for (const t of txs) {
    const d = dayjs(t.date);
    const b = bucketOf(d, dim, ref);
    let g = byKey.get(b.key);
    if (!g) {
      g = { key: b.key, label: b.label, subExpense: 0, subIncome: 0, txs: [], start: b.start };
      byKey.set(b.key, g);
    }
    if (t.type === 'expense') g.subExpense += t.amount;
    else if (t.type === 'income') g.subIncome += t.amount;
    g.txs.push(t);
  }

  const groups = Array.from(byKey.values());
  if (dim === 'day') {
    // 日档：今天 / 昨天 置顶，其余按日期倒序（沿用既有列表行为）
    const rank = (g: TxGroup) => (g.label === '今天' ? 0 : g.label === '昨天' ? 1 : 2);
    groups.sort((a, b) => rank(a) - rank(b) || b.start - a.start);
  } else {
    groups.sort((a, b) => b.start - a.start);
  }
  return groups;
}

/**
 * 分组头是否带"周期小计"。
 * 日档保持既有样式（只有标题），周 / 月 / 档追加「· 支 ¥xx 收 ¥xx」。
 */
export function dimShowsSubtotal(dim: GroupDim): boolean {
  return dim !== 'day';
}
