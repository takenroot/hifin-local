/**
 * useInView（2026-10-06 bento-motion §5）
 * ---------------------------------------------------------------
 * IntersectionObserver 一次性进入视口探测——给 BentoCard 入场动画用。
 * 设计要点：
 *  - 默认 once=true：进入视口后不再撤销（入场是"出现"，不需要再消失）
 *  - SSR/测试安全：typeof IntersectionObserver === 'undefined' 视为
 *    "永远不在视口内"——避免服务端渲染期找不到构造函数崩
 *  - ref 回调：返回的 setter 直接挂到元素上；元素卸载时 observer 自动解绑
 *  - rootMargin 默认 '0px'：视口边缘即触发，不预加载远处区块
 *
 * 返回的 isInView 初始 false（observer 首次回调后才 true）。
 * 一旦 true 即固定（once 模式），不会再变。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export interface UseInViewOptions {
  /** 只触发一次（默认 true） */
  once?: boolean;
  /** 关闭 hook：enabled=false 时不挂 observer，立即返回 isInView=false */
  enabled?: boolean;
  /** IntersectionObserver rootMargin */
  rootMargin?: string;
}

export interface UseInViewReturn<T extends Element> {
  /** 挂到目标元素的 ref 回调 */
  ref: (node: T | null) => void;
  /** 是否已进入视口（once 模式下为单调上升） */
  isInView: boolean;
}

export function useInView<T extends Element = HTMLElement>(
  options: UseInViewOptions = {},
): UseInViewReturn<T> {
  const { once = true, enabled = true, rootMargin = '0px' } = options;
  const [isInView, setInView] = useState(false);
  const nodeRef = useRef<T | null>(null);
  // ref 回调用：记一下当前 observer，节点替换时解绑旧的
  const observerRef = useRef<IntersectionObserver | null>(null);

  // 卸载时解绑 observer
  useEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  const ref = useCallback(
    (node: T | null) => {
      // 节点变了/卸载了：先清掉旧 observer
      observerRef.current?.disconnect();
      observerRef.current = null;
      nodeRef.current = node;
      if (!node || !enabled) return;
      // SSR / 测试 / 极老浏览器：兜底视为"永远不在视口内"
      if (typeof IntersectionObserver === 'undefined') return;
      const obs = new IntersectionObserver(
        (entries) => {
          const entry = entries[0];
          if (!entry?.isIntersecting) return;
          setInView(true);
          if (once) obs.disconnect();
        },
        { rootMargin },
      );
      obs.observe(node);
      observerRef.current = obs;
    },
    [enabled, once, rootMargin],
  );

  return { ref, isInView };
}
