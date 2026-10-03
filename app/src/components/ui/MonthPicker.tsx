/**
 * MonthPicker —— 月份选择弹层（年份 ‹ › 翻页 + 3×4 月份网格）
 * ---------------------------------------------------------------
 * 设计约定：
 *   - 容器用 Modal（见 ui/Modal.tsx），Esc / 点遮罩关闭由 Modal 负责，
 *     本组件只负责"选一个月份"，与组件库保持同一套交互范式。
 *   - 选中月 = 实心块，类名与 SegmentedControl 选中态逐字对齐
 *     （bg-text/text-bg-card ↔ dark:bg-text-dark/dark:text-bg-card-dark），
 *     明暗两侧都保持"实心 = 选中"。
 *   - 真实当前月 = brand 底 + 小圆点；当前月同时被选中时圆点反色，
 *     这样"当前"与"选中"两个状态不会互相吞掉。
 *   - 未来月 / 早于 minMonth 的月 disabled 置灰，指针与键盘都点不动。
 *
 * 明暗双 token：文字、hover 底、禁用态全部成对写 dark: 变体。
 */
import { useEffect, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import clsx from 'clsx';
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react';

/** 网格里的一格 */
export interface MonthCell {
  /** 月份 1..12 */
  month: number;
  /** 越界（未来 / 早于最早交易月）时置灰禁用 */
  disabled: boolean;
  /** 真实当前月 */
  isCurrent: boolean;
}

/** 某年某月的月初（本地时区，勿用 UTC 字符串解析） */
export function monthStartOf(year: number, month: number): Dayjs {
  return dayjs(new Date(year, month - 1, 1));
}

/**
 * 生成某年 12 个月的格子状态。
 * - minMonth / maxMonth 是可选区间（看板：最早交易月 ~ 真实当前月）
 * - currentMonth 默认等于 maxMonth；两者不等时需要显式传入
 */
export function monthCellsOf(
  year: number,
  minMonth: Dayjs,
  maxMonth: Dayjs,
  currentMonth: Dayjs = maxMonth,
): MonthCell[] {
  const cells: MonthCell[] = [];
  for (let month = 1; month <= 12; month++) {
    const d = monthStartOf(year, month);
    cells.push({
      month,
      disabled: d.isAfter(maxMonth, 'month') || d.isBefore(minMonth, 'month'),
      isCurrent: d.isSame(currentMonth, 'month'),
    });
  }
  return cells;
}

/** 12 格切成 3 行 × 4 列 */
export function monthGridRows(cells: MonthCell[]): MonthCell[][] {
  const rows: MonthCell[][] = [];
  for (let i = 0; i < cells.length; i += 4) rows.push(cells.slice(i, i + 4));
  return rows;
}

export interface MonthPickerProps {
  /** 当前选中的月份 */
  selected: Dayjs;
  /** 可选区间下界（含），早于它的月份禁用 */
  minMonth: Dayjs;
  /** 可选区间上界（含），晚于它的月份禁用 */
  maxMonth: Dayjs;
  /** 真实当前月，默认与 maxMonth 同值 */
  currentMonth?: Dayjs;
  onSelect: (month: Dayjs) => void;
  className?: string;
}

export function MonthPicker({
  selected,
  minMonth,
  maxMonth,
  currentMonth,
  onSelect,
  className,
}: MonthPickerProps) {
  const now = currentMonth ?? maxMonth;
  // 组件随 Modal 挂载/卸载：每次打开都从当前所选月所在年份开始翻
  const [year, setYear] = useState(selected.year());
  useEffect(() => {
    setYear(selected.year());
  }, [selected]);

  const minYear = minMonth.year();
  const maxYear = maxMonth.year();
  const rows = monthGridRows(monthCellsOf(year, minMonth, maxMonth, now));

  return (
    <div
      className={clsx('text-text dark:text-text-dark', className)}
      data-testid="month-picker"
      data-year={year}
    >
      {/* 年份翻页 */}
      <div className="flex items-center justify-between mb-3" data-testid="month-picker-year-nav">
        <button
          type="button"
          onClick={() => setYear(year - 1)}
          disabled={year <= minYear}
          aria-label="上一年"
          title="上一年"
          data-testid="month-picker-prev-year"
          className={clsx(
            'w-8 h-8 flex-none flex items-center justify-center rounded-lg transition cursor-pointer',
            'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
            year <= minYear && 'opacity-40 cursor-not-allowed hover:bg-transparent',
          )}
        >
          <IconChevronLeft size={16} />
        </button>
        <span
          className="text-sm font-medium tabular-nums"
          data-testid="month-picker-year"
          aria-live="polite"
        >
          {year}年
        </span>
        <button
          type="button"
          onClick={() => setYear(year + 1)}
          disabled={year >= maxYear}
          aria-label="下一年"
          title="下一年"
          data-testid="month-picker-next-year"
          className={clsx(
            'w-8 h-8 flex-none flex items-center justify-center rounded-lg transition cursor-pointer',
            'text-text-muted dark:text-text-muted-dark hover:text-text dark:hover:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark',
            year >= maxYear && 'opacity-40 cursor-not-allowed hover:bg-transparent',
          )}
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* 3×4 月份网格 */}
      <div className="space-y-1.5" data-testid="month-picker-grid">
        {rows.map((row, ri) => (
          <div key={ri} className="grid grid-cols-3 gap-1.5">
            {row.map((cell) => {
              // 注意：dayjs 的 month() 是 0 基，格子 month 是 1~12
              const isSelected = year === selected.year() && cell.month === selected.month() + 1;
              return (
                <button
                  key={cell.month}
                  type="button"
                  disabled={cell.disabled}
                  onClick={() => onSelect(monthStartOf(year, cell.month))}
                  aria-label={`${year}年${cell.month}月`}
                  aria-current={cell.isCurrent ? 'true' : undefined}
                  title={cell.isCurrent ? `${year}年${cell.month}月（当前月）` : undefined}
                  data-testid="month-picker-cell"
                  data-month={cell.month}
                  data-selected={isSelected ? 'true' : undefined}
                  data-current={cell.isCurrent ? 'true' : undefined}
                  className={clsx(
                    'h-10 rounded-lg text-sm transition flex items-center justify-center gap-1 whitespace-nowrap',
                    isSelected
                      ? 'bg-text text-bg-card dark:bg-text-dark dark:text-bg-card-dark font-medium cursor-pointer'
                      : cell.disabled
                        ? 'text-text-muted dark:text-text-muted-dark opacity-40 cursor-not-allowed'
                        : cell.isCurrent
                          ? 'bg-brand-soft dark:bg-brand/20 text-brand font-medium hover:bg-brand-soft dark:hover:bg-brand/30 cursor-pointer'
                          : 'text-text dark:text-text-dark hover:bg-bg dark:hover:bg-bg-card-dark cursor-pointer',
                  )}
                >
                  {cell.month}月
                  {cell.isCurrent && (
                    <span
                      aria-hidden
                      className={clsx(
                        'w-1 h-1 rounded-full flex-none',
                        isSelected ? 'bg-bg-card dark:bg-bg-card-dark' : 'bg-brand',
                      )}
                    />
                  )}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export default MonthPicker;
