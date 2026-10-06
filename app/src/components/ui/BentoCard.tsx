/**
 * BentoCard（2026-10-06 bento-motion §4 + §5）
 * ---------------------------------------------------------------
 * 看板卡统一入口编排：
 *  - 入场 fade-up（12px → 0 + opacity 0 → 1），480ms --dur-enter
 *  - stagger 由调用方传 delayStep（步进 40ms 推算 delay ms），不内置节奏——
 *    节奏属编排层（Wave 2 看板会做），本组件只暴露 prop
 *  - hover lift：translateY(-2px) + shadow.lift，160ms --dur-surface
 *    必须用 @media (hover:hover) and (pointer:fine) 门控：
 *    触屏长按会触发 :hover，强行悬浮会导致页面跟着手指抖
 *  - 可选 useInView：折线以下区块不在首屏，没进视口就保持 opacity:0/translateY(12px)，
 *    进视口才触发入场；Wave 2 用，本轮不挂载
 *
 * 三个 prop 语义：
 *  - delayStep  步进号（0/1/2...），组件按 40ms 折算 delay
 *  - glass      套 .glass（侧边栏 / ⌘K / 通知 / toast 等需要玻璃面的场景）
 *  - lift       启用 hover lift（数据卡 24/7 用，浮窗/弹窗不要——会与关闭手势冲突）
 */
import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import clsx from 'clsx';
import { useInView } from '@/hooks/useInView';

/** stagger 步进宽度（设计 §4：40ms/step）。单独提常量便于测试断言 */
export const BENTO_STAGGER_MS = 40;
/** 入场位移距离（设计 §4：12px） */
export const BENTO_ENTER_OFFSET_PX = 12;
/** hover lift 位移（设计 §4：-2px） */
export const BENTO_HOVER_LIFT_PX = -2;

/**
 * 给定步进号换算入场 delay（ms）。封装到函数是因为组件 prop 只暴露 step，
 * 不暴露 ms——避免调用方手算出错。
 */
export function bentoDelayMs(step: number): number {
  // ponytail: 简单线性，O(1)。step ≤ 0 视为"立即"（用户视觉无延迟）
  return Math.max(0, step) * BENTO_STAGGER_MS;
}

export interface BentoCardProps extends HTMLAttributes<HTMLDivElement> {
  /** stagger 步进号（默认 0） */
  delayStep?: number;
  /** 玻璃面（仅视觉层启用 .glass，hover lift 仍可用） */
  glass?: boolean;
  /** hover lift：默认 true——卡片默认就该悬浮 */
  lift?: boolean;
  /** 视口外不入场：传 true 则进视口才触发（Wave 2 折线以下区块用） */
  inView?: boolean;
  children?: ReactNode;
}

export const BentoCard = forwardRef<HTMLDivElement, BentoCardProps>(
  function BentoCard(
    {
      delayStep = 0,
      glass = false,
      lift = true,
      inView = false,
      className,
      style,
      children,
      ...rest
    },
    ref,
  ) {
    // inView=false 时 useInView 不挂 observer（enabled=false 短路），
    // 组件挂载即视为可见——首屏卡片 fade-up 立刻跑，不用等视口触发
    const view = useInView<HTMLDivElement>({ enabled: inView, once: true });
    const setRef = (node: HTMLDivElement | null) => {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
      view.ref(node);
    };

    const visible = inView ? view.isInView : true;
    const delay = bentoDelayMs(delayStep);

    return (
      <div
        ref={setRef}
        className={clsx(
          'card',
          // 入场：未触发时停在初始态（translateY 12px + opacity 0）
          // 触发后跑 --dur-enter ease-out 到终态。bento-enter 类名同时
          // 供 reduced-motion 媒体查询降级 transform（见 index.css）。
          'bento-enter',
          visible && 'bento-enter-active',
          glass && 'glass',
          // hover lift：只在精确指针设备启用（触屏 hover 假触不可靠）
          lift && 'bento-hover-lift',
          className,
        )}
        style={{
          // 入场 delay 走 inline style（其它动画 prop 都在 className 里）；
          // 这是唯一一个每张卡都不同的样式变量。
          ['--bento-enter-delay' as string]: `${delay}ms`,
          ...style,
        }}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
