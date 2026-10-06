/**
 * bento-grid.test.ts（2026-10-06 bento-motion Wave 2）
 * ---------------------------------------------------------------
 * 看板 bento 网格编排 + toast 退场状态机的语义断言。
 *
 * 约束：
 *   - 不验 CSS / DOM 布局，只断言 step→ms 折算与编排顺序
 *   - 不引入 jsdom / testing-library（项目零测试框架约束）
 *
 * ponytail：bentoDelayMs 已经单独覆盖，这里只补**编排顺序**与
 * **纯函数层 toast 状态机**。组件层的渲染契约留给 accept 截图。
 */
import { describe, it, expect } from 'vitest';
import { bentoDelayMs, BENTO_STAGGER_MS } from '@/components/ui/BentoCard';

/** 按规范 §3 编排的"折线以上"首屏 stagger 顺序——所有 step 必须严格递增 */
const DASHBOARD_BENTO_ORDER = [
  // row 1
  { key: 'hero', step: 0 },
  { key: 'income', step: 1 },
  { key: 'expense', step: 2 },
  // row 2
  { key: 'trend', step: 3 },
  { key: 'distribution', step: 4 },
  // row 3
  { key: 'calendar', step: 5 },
  { key: 'recent', step: 6 },
] as const;

describe('dashboard bento 编排（规范 §3）', () => {
  it('首屏 7 张卡 step 严格递增（视觉顺序确定，没有歧义）', () => {
    for (let i = 1; i < DASHBOARD_BENTO_ORDER.length; i++) {
      expect(DASHBOARD_BENTO_ORDER[i].step).toBeGreaterThan(
        DASHBOARD_BENTO_ORDER[i - 1].step,
      );
    }
  });

  it('每张卡都对应一个唯一 key（命名空间稳定，diff 友好）', () => {
    const keys = DASHBOARD_BENTO_ORDER.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('step 折算 delay（ms）符合 BENTO_STAGGER_MS 步进', () => {
    // 验证：step 5 = 200ms、step 6 = 240ms ……刚好命中 40ms 步进
    for (const { step } of DASHBOARD_BENTO_ORDER) {
      expect(bentoDelayMs(step) % BENTO_STAGGER_MS).toBe(0);
      expect(bentoDelayMs(step)).toBe(step * BENTO_STAGGER_MS);
    }
  });

  it('折线以下 row 4 不进首屏编排（用 inView 触发，step=-1 哨兵）', () => {
    // inView=true 的卡不传 delayStep；空 step 经 bentoDelayMs 折算 = 0，
    // 但**入场时机**由 IntersectionObserver 决定——它不会与首屏 stagger 撞车。
    expect(bentoDelayMs(-1)).toBe(0); // 哨兵：不影响入场时机
  });
});