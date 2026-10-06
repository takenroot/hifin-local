/**
 * 视觉实验室（/lab）测试——只测数据生成器的确定性与结构契约，
 * 不测 CSS/DOM（实验室页有意允许违反规范）。
 */
import { describe, it, expect } from 'vitest';
import {
  genLabTrend,
  dateBefore,
  LAB_ANCHOR,
  LAB_SLICES,
  LAB_STATS,
} from '@/features/lab/DashboardLab';

describe('lab 静态数据：确定性（对照实验前提）', () => {
  it('同一天任意次数调用，趋势数据逐点一致', () => {
    const a = genLabTrend();
    const b = genLabTrend();
    expect(a).toEqual(b);
  });

  it('默认 30 个点，日期锚定且连续递减一天一个', () => {
    const t = genLabTrend();
    expect(t).toHaveLength(30);
    expect(t[29].date).toBe(LAB_ANCHOR);
    expect(t[28].date).toBe(dateBefore(LAB_ANCHOR, 1));
    expect(t[0].date).toBe(dateBefore(LAB_ANCHOR, 29));
  });

  it('数据点为正数且围绕基线波动（不会漂成负值/爆炸值）', () => {
    for (const p of genLabTrend()) {
      expect(p.value).toBeGreaterThan(20000);
      expect(p.value).toBeLessThan(50000);
    }
  });
});

describe('lab 样例结构契约', () => {
  it('三卡语义色口径与生产一致：好事绿 / 坏事红', () => {
    // 净资产 -1.47%（坏事）→ expense 红；收入/支出 delta 为"好方向" → income 绿
    expect(LAB_STATS.netAsset.tone).toBe('expense');
    expect(LAB_STATS.income.tone).toBe('income');
    expect(LAB_STATS.expense.tone).toBe('income');
  });

  it('资产分布样例非空且金额为正', () => {
    expect(LAB_SLICES.length).toBeGreaterThanOrEqual(2);
    for (const s of LAB_SLICES) expect(s.value).toBeGreaterThan(0);
  });
});
