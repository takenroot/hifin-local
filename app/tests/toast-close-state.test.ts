/**
 * toast-close-state.test.ts（2026-10-06 bento-motion Wave 2）
 * ---------------------------------------------------------------
 * toast 退出状态机的语义断言（§4 对称路径）。
 *
 * 核心契约：
 *   - 关闭动画时长 = 入场 --dur-overlay（220ms），让 data-state="closed"
 *     后 CSS 有时间播完退场动画再 unmount
 *   - 退出阶段幂等：已经在 closingKeys 集合里的 toast 不再重入定时器
 *   - 到期判定：expiresAt <= now 才进入退出阶段
 */
import { describe, it, expect } from 'vitest';
import {
  shouldEnterClosing,
  TOAST_FADE_OUT_MS,
} from '@/features/notifications/NotificationCenter';

describe('toast 退场动画时长（与入场对称）', () => {
  it('TOAST_FADE_OUT_MS = 220ms，对齐 --dur-overlay', () => {
    expect(TOAST_FADE_OUT_MS).toBe(220);
  });
});

describe('shouldEnterClosing（纯函数退出状态判定）', () => {
  const mk = (key: number, expiresAt: number) => ({ key, expiresAt });

  it('已过期且不在退场中 → 进入退场', () => {
    expect(shouldEnterClosing(mk(1, 1000), 1500, new Set())).toBe(true);
  });

  it('未过期 → 不进入退场（提前卸载会被用户看成 bug）', () => {
    expect(shouldEnterClosing(mk(1, 5000), 1500, new Set())).toBe(false);
  });

  it('已过期但已在退场 → 不重入（定时器已排队，再排一次会延后 unmount）', () => {
    const closing = new Set([1]);
    expect(shouldEnterClosing(mk(1, 1000), 1500, closing)).toBe(false);
  });

  it('已过期且 other toast 在退场中 → 仍可进入退场（独立 key 独立计时）', () => {
    // 验证：批处理——多条同时到期时，每条 toast 各自进入退场，
    // 不被其他 toast 的 in-flight 状态拦下。
    const closing = new Set([2]);
    expect(shouldEnterClosing(mk(1, 1000), 1500, closing)).toBe(true);
  });

  it('到期边界：expiresAt === now 视为过期（设计 §4：TTL 命中即触发）', () => {
    expect(shouldEnterClosing(mk(1, 1500), 1500, new Set())).toBe(true);
  });
});