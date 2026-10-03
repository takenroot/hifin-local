/**
 * MonthPicker 纯逻辑单测
 * ---------------------------------------------------------------
 * 只测与 DOM 无关的部分：区间判定（未来月 / 早于下界禁用）、当前月标记、
 * 以及 3×4 网格切行。渲染层（实心/置灰样式）交给 accept 脚本断言。
 */
import { describe, it, expect } from 'vitest';
import dayjs from 'dayjs';
import { monthCellsOf, monthGridRows, monthStartOf } from '@/components/ui/MonthPicker';

const min = monthStartOf(2025, 12); // 最早交易月
const current = monthStartOf(2026, 10); // 真实当前月 = 上界
const cellsOf = (year: number) => monthCellsOf(year, min, current, current);
const enabledMonths = (year: number) =>
  cellsOf(year)
    .filter((c) => !c.disabled)
    .map((c) => c.month);

describe('monthStartOf', () => {
  it('返回该年该月的月初，且不受"今天几号"影响', () => {
    const d = monthStartOf(2026, 3);
    expect(d.format('YYYY-MM-DD')).toBe('2026-03-01');
    expect(d.date()).toBe(1);
    expect(d.month()).toBe(2); // dayjs month() 是 0 基
  });

  it('12 月不会被滚到下一年', () => {
    expect(monthStartOf(2026, 12).format('YYYY-MM')).toBe('2026-12');
  });
});

describe('monthCellsOf', () => {
  it('恒返回 12 格，月份为 1..12', () => {
    const cells = cellsOf(2026);
    expect(cells).toHaveLength(12);
    expect(cells.map((c) => c.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('晚于当前月的月份禁用（上界）', () => {
    // 当前月 = 2026-10 → 11/12 月是未来
    expect(enabledMonths(2026)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('早于最早交易月的月份禁用（下界）', () => {
    // 最早交易月 = 2025-12 → 该年只有 12 月可选
    expect(enabledMonths(2025)).toEqual([12]);
    // 再早一年整年都不可用
    expect(enabledMonths(2024)).toEqual([]);
  });

  it('区间内的月份既不禁用也不是当前月', () => {
    const cell = cellsOf(2026).find((c) => c.month === 5)!;
    expect(cell.disabled).toBe(false);
    expect(cell.isCurrent).toBe(false);
  });

  it('只把真实当前月标记为 isCurrent', () => {
    const currents = cellsOf(2026).filter((c) => c.isCurrent).map((c) => c.month);
    expect(currents).toEqual([10]);
  });

  it('isCurrent 与 disabled 相互独立（当前月即使被选也不会因自己是当前月而禁用）', () => {
    const cell = cellsOf(2026).find((c) => c.month === 10)!;
    expect(cell).toMatchObject({ month: 10, disabled: false, isCurrent: true });
  });

  it('currentMonth 与 maxMonth 不同时，只有显式传入的那个月带 isCurrent', () => {
    const cells = monthCellsOf(2026, min, current, monthStartOf(2026, 3));
    expect(cells.filter((c) => c.isCurrent).map((c) => c.month)).toEqual([3]);
    // 上界仍然是 10 月：11/12 月依旧禁用
    expect(cells.find((c) => c.month === 11)!.disabled).toBe(true);
  });

  it('默认把 maxMonth 当作当前月', () => {
    const cells = monthCellsOf(2026, min, current);
    expect(cells.filter((c) => c.isCurrent).map((c) => c.month)).toEqual([10]);
  });

  it('空库场景（上下界都等于当前月）只有当前月之后禁用，之前只是空月', () => {
    // 下界回退成当前月时，判据是"晚于上界即禁用"：11/12 月禁用，
    // 1~9 月虽可选但日历没有任何数据点（与日历-month-nav 翻页器到不了它们无关）。
    const now = monthStartOf(2026, 10);
    const cells = monthCellsOf(2026, now, now, now);
    expect(enabledMonths(2026)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(cells.filter((c) => c.isCurrent).map((c) => c.month)).toEqual([10]);
    expect(cells.find((c) => c.month === 10)!.disabled).toBe(false);
    expect(cells.find((c) => c.month === 11)!.disabled).toBe(true);
  });
});

describe('monthGridRows', () => {
  it('12 格切成 3 行 × 4 列', () => {
    const rows = monthGridRows(cellsOf(2026));
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.length)).toEqual([4, 4, 4]);
    expect(rows.flat().map((c) => c.month)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('切行不丢格也不重复', () => {
    const rows = monthGridRows(cellsOf(2025));
    expect(rows.flat()).toHaveLength(12);
    expect(new Set(rows.flat().map((c) => c.month)).size).toBe(12);
  });
});

describe('与 dayjs 口径一致', () => {
  it('边界月用 isSame/isBefore(…, "month") 判定不会因日期非 1 号而错判', () => {
    // 真实数据里最早那笔可能发生在月中，下界取的是它的"月初"
    const firstTx = dayjs(new Date(2025, 11, 18)); // 2025-12-18
    const derived = firstTx.startOf('month');
    expect(derived.isSame(min, 'month')).toBe(true);
    expect(cellsOf(2025)[0].disabled).toBe(true); // 2025-01 早于 2025-12
    expect(cellsOf(2025)[11].disabled).toBe(false); // 2025-12 可选
  });
});
