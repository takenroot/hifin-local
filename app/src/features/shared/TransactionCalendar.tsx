/**
 * TransactionCalendar —— 收支日历（共享组件）
 * ----------------------------------------------------------------
 * 从 dashboard/Dashboard.tsx 抽出（Wave A 2026-10-06）。旧看板内的原
 * 实现（MonthCalendar + 日历卡片 + MonthPicker 弹层）将在 Wave B 随
 * 看板整体重写时移除。本文件自包含，不依赖 features/dashboard/，方便
 * 交易页 / 未来其它视图直接接入。
 *
 * 设计要点：
 *  - 视觉沿用旧看板：card 容器、grid-cols-7、收入 text-income / 支出
 *    text-expense 语义色小计；明暗双 token 通过 Tailwind dark: 变体自动成立。
 *  - 月份状态 / 翻页下界（最早交易月） / 「今天」 / MonthPicker 全部内聚，
 *    调用方只传 transactions 与 onSelectDay。
 *  - 日聚合逻辑抽成导出纯函数 aggregateCalendarDays，供单测覆盖。
 *  - onSelectDay 给的是 dateKey 字符串（YYYY-MM-DD），方便调用方直接
 *    接到 TxFilter.from/to。交易页本期已接入：点日 → 切回列表 tab +
 *    按当日过滤。
 */
import { useCallback, useMemo, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import clsx from 'clsx';
import {
  IconChevronLeft,
  IconChevronRight,
  IconChevronDown,
} from '@tabler/icons-react';
import { Card, Modal, MonthPicker } from '@/components/ui';
import { formatMoney } from '@/lib/format';

/** 单笔流水（与交易页对接的最小字段） */
export interface CalendarTransaction {
  /** 流水发生时刻（毫秒） */
  date: number;
  /** income / expense / transfer / excluded —— transfer 与 excluded 不计入日历小计 */
  type: string;
  amount: number;
}

/** 单日小计 */
export interface CalendarDay {
  /** 该日 0 点（本地时区） */
  date: Dayjs;
  /** 收入合计 */
  income: number;
  /** 支出合计 */
  expense: number;
  /** 当日计入日历的流水数（用于小圆点提示） */
  count: number;
}

/**
 * 按日聚合收入 / 支出（transfer / excluded 不计入）。
 * 跨月归属：每笔交易按自己的 timestamp 落入对应日，月份下界点取最小
 * 交易月/最早交易月由调用方另行判定。
 *
 * 纯函数，导出供单测使用；与 dashboard/calculations.buildCalendar
 * 等价，但签名只依赖 3 个最小字段，避免向调用方泄漏全量 Transaction 类型。
 */
export function aggregateCalendarDays(
  transactions: ReadonlyArray<CalendarTransaction>,
  month: Dayjs,
): CalendarDay[] {
  const start = month.startOf('month');
  const daysInMonth = month.daysInMonth();
  const map = new Map<string, { income: number; expense: number; count: number }>();
  for (const t of transactions) {
    if (t.type === 'transfer' || t.type === 'excluded') continue;
    const day = dayjs(t.date).startOf('day');
    if (day.month() !== month.month() || day.year() !== month.year()) continue;
    const key = day.format('YYYY-MM-DD');
    const cur = map.get(key) ?? { income: 0, expense: 0, count: 0 };
    if (t.type === 'income') cur.income += t.amount;
    else if (t.type === 'expense') cur.expense += t.amount;
    cur.count += 1;
    map.set(key, cur);
  }
  const out: CalendarDay[] = [];
  for (let i = 0; i < daysInMonth; i++) {
    const d = start.add(i, 'day');
    const key = d.format('YYYY-MM-DD');
    const cur = map.get(key);
    out.push({
      date: d,
      income: cur?.income ?? 0,
      expense: cur?.expense ?? 0,
      count: cur?.count ?? 0,
    });
  }
  return out;
}

/** 月份下界：全量最早一笔日历可见交易（income/expense）所在月；空库返回 null。 */
export function earliestTransactionMonth(
  transactions: ReadonlyArray<CalendarTransaction>,
): Dayjs | null {
  let min: number | null = null;
  for (const t of transactions) {
    if (t.type === 'transfer' || t.type === 'excluded') continue;
    if (min === null || t.date < min) min = t.date;
  }
  return min === null ? null : dayjs(min).startOf('month');
}

/** 月份文字：2026年10月。 */
function monthLabelCn(month: Dayjs): string {
  return month.format('YYYY年M月');
}

export interface TransactionCalendarProps {
  transactions: ReadonlyArray<CalendarTransaction>;
  /**
   * 点选某日时回调，参数为 YYYY-MM-DD 字符串。
   * 不传时日历只展示网格、不响应点击。
   */
  onSelectDay?: (dateKey: string) => void;
  /** 标题，默认"收支日历" */
  title?: string;
}

/**
 * 自包含的收支日历：包含卡片头部（翻页 + 「今天」 + 月份选择弹层），
 * 以及 7 列网格 + 周标题 + 日收入 / 支出小计。
 */
export function TransactionCalendar({
  transactions,
  onSelectDay,
  title = '收支日历',
}: TransactionCalendarProps) {
  // 「当前月」在组件挂载时取一次即可；翻页状态独立维护。
  const currentMonth = useMemo(() => dayjs().startOf('month'), []);

  /* 月份状态：默认本月；不持久化——刷新回到当前月与看板口径一致 */
  const [month, setMonth] = useState<Dayjs>(() => dayjs().startOf('month'));

  const minMonth = useMemo(
    () => earliestTransactionMonth(transactions) ?? currentMonth,
    [transactions, currentMonth],
  );
  const atMin = month.isSame(minMonth, 'month');
  const atMax = month.isSame(currentMonth, 'month');

  const days = useMemo(() => aggregateCalendarDays(transactions, month), [transactions, month]);

  const step = useCallback(
    (delta: -1 | 1) => {
      const next = month.add(delta, 'month').startOf('month');
      if (next.isAfter(currentMonth, 'month')) return; // 上界：未来月
      if (next.isBefore(minMonth, 'month')) return; // 下界：早于最早交易月
      setMonth(next);
    },
    [month, currentMonth, minMonth],
  );
  const backToCurrent = useCallback(() => setMonth(currentMonth), [currentMonth]);

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickMonth = useCallback((m: Dayjs) => {
    setMonth(m.startOf('month'));
    setPickerOpen(false);
  }, []);

  return (
    <>
      <Card
        title={title}
        extra={
          <div className="flex items-center gap-1" data-testid="cal-nav">
            <button
              type="button"
              onClick={() => step(-1)}
              title="上一月"
              aria-label="上一月"
              data-testid="cal-prev"
              disabled={atMin}
              className={clsx(
                'w-7 h-7 sm:w-8 sm:h-8 flex-none flex items-center justify-center rounded-lg transition',
                'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                atMin && 'opacity-40 cursor-not-allowed hover:bg-transparent',
              )}
            >
              <IconChevronLeft size={16} />
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              title="选择月份"
              aria-label={`选择月份，当前 ${monthLabelCn(month)}`}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              data-testid="cal-label"
              className="min-w-[4.75rem] sm:min-w-[7.5rem] -mx-1.5 px-1.5 inline-flex items-center justify-center gap-0.5 rounded-lg text-center text-xs sm:text-sm font-medium text-text dark:text-text-dark tabular-nums hover:bg-bg dark:hover:bg-bg-card-dark transition-colors cursor-pointer"
            >
              {monthLabelCn(month)}
              <IconChevronDown size={12} aria-hidden className="flex-none opacity-60" />
            </button>
            <button
              type="button"
              onClick={() => step(1)}
              title="下一月"
              aria-label="下一月"
              data-testid="cal-next"
              disabled={atMax}
              className={clsx(
                'w-7 h-7 sm:w-8 sm:h-8 flex-none flex items-center justify-center rounded-lg transition',
                'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
                atMax && 'opacity-40 cursor-not-allowed hover:bg-transparent',
              )}
            >
              <IconChevronRight size={16} />
            </button>
            {!atMax && (
              <button
                type="button"
                onClick={backToCurrent}
                title="回到当前月"
                aria-label="回到当前月"
                data-testid="cal-today"
                className="ml-0.5 flex-none text-[11px] sm:text-xs text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark transition-colors cursor-pointer"
              >
                今天
              </button>
            )}
          </div>
        }
      >
        <div data-testid="cal-grid">
          <CalendarGrid month={month} days={days} onSelect={onSelectDay} />
        </div>
      </Card>

      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="选择月份"
        hideClose
        width={340}
      >
        <MonthPicker
          selected={month}
          minMonth={minMonth}
          maxMonth={currentMonth}
          currentMonth={currentMonth}
          onSelect={pickMonth}
        />
      </Modal>
    </>
  );
}

/* ───────────────── 月历网格（纯展示） ───────────────── */

interface CalendarGridProps {
  month: Dayjs;
  days: CalendarDay[];
  onSelect?: (dateKey: string) => void;
}

function CalendarGrid({ month, days, onSelect }: CalendarGridProps) {
  const today = dayjs();
  const startWeekday = month.startOf('month').day(); // 0=Sun
  const cells: Array<{ date: Dayjs | null; income: number; expense: number; count: number }> = [];
  for (let i = 0; i < startWeekday; i++) cells.push({ date: null, income: 0, expense: 0, count: 0 });
  for (const d of days) cells.push(d);
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
          const dateKey = day.format('YYYY-MM-DD');
          return (
            <button
              key={dateKey}
              type="button"
              onClick={() => onSelect?.(dateKey)}
              className={clsx(
                'h-16 rounded-lg border flex flex-col items-stretch justify-between p-1.5 text-left transition',
                isToday
                  ? 'border-text dark:border-bg-card bg-bg dark:bg-bg-card-dark'
                  : 'border-transparent hover:bg-bg dark:hover:bg-bg-card-dark',
                onSelect && c.count > 0 && 'cursor-pointer',
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

export default TransactionCalendar;