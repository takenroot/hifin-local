/**
 * Aurora 背景（2026-10-06 bento-motion §4 + §5）
 * ---------------------------------------------------------------
 * 常驻氛围层：两层径向渐变，CSS keyframes 24s linear ±3% 漂移。
 * 设计原则（Emil Kowalski）：不该动的绝不动——这是装饰层，不承载数据，
 * 因此仅做极慢 transform/opacity 漂移，不参与交互。
 *
 * 深底：emerald #10b981 ≤8% + slate 中性；亮底：中性灰 ≤6%（规范 §1）。
 * 永不使用饱和全色相，避免抢数据（规范 §1 禁紫色/霓虹渐变）。
 *
 * 三个不可妥协点：
 *  1. aria-hidden：装饰元素不进 a11y 树
 *  2. prefers-reduced-motion：aurora-layer 全局降级已冻结动画（index.css）
 *  3. transform/opacity only：任何动效配料都不能触发布局/重绘
 *
 * 零新依赖：纯 CSS keyframes；本组件只渲染两枚绝对定位 div + 两段 className。
 */
export function AuroraBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* 深底：emerald 弱饱和；亮底自动走中性灰（index.css dark 选择器）。
          两侧反向漂移避免视觉对称导致的"胶片抖动"感。 */}
      <div
        className="aurora-layer absolute inset-0"
        style={{
          background:
            'radial-gradient(60% 50% at 20% 30%, rgba(16,185,129,0.08) 0%, transparent 60%)',
          animation: 'aurora-drift-a 24s linear infinite',
        }}
      />
      <div
        className="aurora-layer absolute inset-0"
        style={{
          background:
            'radial-gradient(50% 45% at 80% 70%, rgba(148,163,184,0.06) 0%, transparent 60%)',
          animation: 'aurora-drift-b 24s linear infinite',
        }}
      />
      {/* 亮底：两枚中性灰 ≤6%（无 emerald 参与）。
          aurora-drift-light 是浅色专属动画类，深底不会触发。 */}
      <style>{`
        @keyframes aurora-drift-a {
          0%, 100% { transform: translate3d(0, 0, 0); opacity: 1; }
          50%      { transform: translate3d(3%, -3%, 0); opacity: 0.85; }
        }
        @keyframes aurora-drift-b {
          0%, 100% { transform: translate3d(0, 0, 0); opacity: 1; }
          50%      { transform: translate3d(-3%, 3%, 0); opacity: 0.85; }
        }
        /* 亮底走中性灰路径：覆盖上面 emerald 的 0.08 → 中性灰 0.06 */
        :root:not(.dark) .aurora-layer:first-of-type {
          background: radial-gradient(60% 50% at 20% 30%, rgba(148,163,184,0.06) 0%, transparent 60%) !important;
        }
      `}</style>
    </div>
  );
}
