/**
 * TransactionCalendar 纯逻辑单测
 * ---------------------------------------------------------------
 * 只测与 DOM 无关的部分：
 *  - aggregateCalendarDays：收入 / 支出分组，跨月归属，transfer / excluded 排除
 *  - earliestTransactionMonth：下界 = 最早一笔日历可见交易所在月；空库返回 null
 *  - dateKey 格式化：YYYY-MM-DD
 * 渲染层（暗色 / 网格 / 翻页器 disabled 状态）交给 playwright 截图肉眼核。
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import {
  aggregateCalendarDays,
  earliestTransactionMonth,
  type CalendarTransaction,
} from '@/features/shared/TransactionCalendar';

const D = (y: number, m: number, d: number, hh = 12, mm = 0): number =>
  new Date(y, m - 1, d, hh, mm, 0, 0).getTime();

const T = (date: number, type: CalendarTransaction['type'], amount: number): CalendarTransaction => ({
  date,
  type,
  amount,
});

describe('aggregateCalendarDays', () => {
  it('按日聚合收入与支出，transfer / excluded 不计入', () => {
    const month = dayjs(new Date(2026, 9, 1)); // 2026-10
    const rows: CalendarTransaction[] = [
      T(D(2026, 10, 5, 9), 'expense', 30), // 早餐 30
      T(D(2026, 10, 5, 18), 'expense', 70), // 晚餐 70 → 当天支出 100
      T(D(2026, 10, 5, 10), 'income', 500), // 当天收入 500
      T(D(2026, 10, 5, 12), 'transfer', 999), // 转账不算
      T(D(2026, 10, 5, 13), 'excluded', 999), // excluded 不算
      T(D(2026, 10, 6, 20), 'expense', 25), // 第二天支出 25
    ];
    const days = aggregateCalendarDays(rows, month);

    expect(days).toHaveLength(31); // 10 月 31 天
    const day5 = days[4];
    const day6 = days[5];
    expect(day5.date.format('YYYY-MM-DD')).toBe('2026-10-05');
    expect(day5.income).toBe(500);
    expect(day5.expense).toBe(100); // 30 + 70
    expect(day5.count).toBe(3); // 早餐 + 晚餐 + 收入；transfer / excluded 不计入
    expect(day6.income).toBe(0);
    expect(day6.expense).toBe(25);
    expect(day6.count).toBe(1);
  });

  it('跨月归属：每笔交易按自己的时间戳落入对应日期，不串月', () => {
    const month = dayjs(new Date(2026, 8, 1)); // 2026-09
    const rows: CalendarTransaction[] = [
      T(D(2026, 9, 30, 23, 59), 'expense', 11), // 9 月最后一天
      T(D(2026, 10, 1, 0, 0), 'expense', 22), // 10 月第一天 → 不计入 9 月
      T(D(2026, 9, 15), 'income', 333),
    ];
    const days = aggregateCalendarDays(rows, month);

    const day30Sep = days[days.length - 1]; // 9 月 30 日
    expect(day30Sep.date.format('YYYY-MM-DD')).toBe('2026-09-30');
    expect(day30Sep.expense).toBe(11);
    expect(day30Sep.count).toBe(1);

    const day15 = days[14];
    expect(day15.income).toBe(333);
    expect(day15.count).toBe(1);

    // 10 月那笔不算入 9 月日历
    expect(days.reduce((s, d) => s + d.expense, 0)).toBe(11);
  });

  it('空月份：days 长度 = 当月天数，所有项为 0', () => {
    const month = dayjs(new Date(2026, 1, 1)); // 2026-02（28 天）
    const days = aggregateCalendarDays([], month);
    expect(days).toHaveLength(28);
    expect(days.every((d) => d.income === 0 && d.expense === 0 && d.count === 0)).toBe(true);
  });

  it('dateKey 形如 YYYY-MM-DD：跨年 / 跨月都能对齐到日', () => {
    const month = dayjs(new Date(2026, 0, 1)); // 2026-01
    const rows: CalendarTransaction[] = [
      T(D(2026, 1, 1), 'income', 1),
      T(D(2026, 1, 31, 23), 'expense', 2),
      T(D(2025, 12, 31), 'expense', 99), // 上一年最后一秒 → 不计入
    ];
    const days = aggregateCalendarDays(rows, month);

    expect(days[0].date.format('YYYY-MM-DD')).toBe('2026-01-01');
    expect(days[0].income).toBe(1);
    expect(days[30].date.format('YYYY-MM-DD')).toBe('2026-01-31');
    expect(days[30].expense).toBe(2);
    expect(days.reduce((s, d) => s + d.expense, 0)).toBe(2);
  });
});

describe('earliestTransactionMonth', () => {
  it('返回最早一笔日历可见交易所在月的月初，transfer / excluded 不计入', () => {
    const rows: CalendarTransaction[] = [
      T(D(2026, 5, 10), 'transfer', 999), // 不算
      T(D(2025, 12, 18, 9), 'expense', 50), // 最早一笔
      T(D(2026, 2, 1), 'income', 1000),
      T(D(2026, 3, 1), 'excluded', 999), // 不算
    ];
    const min = earliestTransactionMonth(rows);
    expect(min).not.toBeNull();
    expect(min!.format('YYYY-MM')).toBe('2025-12');
    expect(min!.date()).toBe(1); // 一定是月初
  });

  it('空库 / 全是 transfer/excluded 时返回 null', () => {
    expect(earliestTransactionMonth([])).toBeNull();
    expect(
      earliestTransactionMonth([
        T(D(2026, 1, 1), 'transfer', 1),
        T(D(2026, 2, 1), 'excluded', 2),
      ]),
    ).toBeNull();
  });

  it('月内日期不影响结果：取的是 startOf month', () => {
    const rows: CalendarTransaction[] = [T(D(2025, 12, 31, 23, 59), 'expense', 1)];
    const min = earliestTransactionMonth(rows)!;
    expect(min.format('YYYY-MM-DD')).toBe('2025-12-01');
    expect(min.format('YYYY-MM')).toBe('2025-12');
  });
});