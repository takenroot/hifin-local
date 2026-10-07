import { useEffect, useRef, useState } from 'react';

/**
 * 滚动数字：target 变化时用 rAF + easeOutCubic 从当前显示值平滑过渡到目标值。
 *  - 首次挂载从 0 滚到 target（看板"数出来"的效果）
 *  - target 未变（如 SWR 静默刷新拿到同值）不动画
 *  - prefers-reduced-motion 用户直接跳到终值
 *  - 传 0 再传回原值可强制重滚（StatCard 用它实现"取消隐藏时重滚"）
 */
/** 默认滚动时长 5000ms（2026-10-07 用户决策：数字跳动不要太快） */
export function useAnimatedNumber(target: number, duration = 5000): number {
  const [display, setDisplay] = useState(0);
  // 动画中断时记住已滚到的值，下一段从断点续滚，不跳变
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || duration <= 0) {
      fromRef.current = target;
      setDisplay(target);
      return;
    }
    const from = fromRef.current;
    if (from === target) return;

    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // easeOutCubic：前快后慢，收尾自然
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setDisplay(v);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
        rafRef.current = null;
      }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [target, duration]);

  return display;
}
