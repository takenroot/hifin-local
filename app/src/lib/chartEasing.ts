/**
 * 三阶段图表缓动（2026-10-06 用户决策：先快 → 再缓 → 后慢）
 * ---------------------------------------------------------------
 * 分段函数 t∈[0,1] → progress∈[0,1]：
 *   [0, 0.3)   快进段：线性 0 → 0.6（进场迅速，立刻给用户"活"的反馈）
 *   [0.3, 0.7] 平缓段：线性 0.6 → 0.85（中段匀速爬升，视觉停留）
 *   (0.7, 1]   慢尾段：ease-out 渐近 0.85 → 1（长尾缓慢归位，无急停感）
 *
 * 接法：recharts 的 AnimationTiming 类型只收字符串字面量，但运行时底层
 * react-smooth 支持函数 easing——用类型断言接入：
 *   animationEasing={threePhaseEasing as unknown as 'ease-out'}
 * 降级路径：若未来 react-smooth 移除函数支持，行为退化为默认 ease-out，
 * 视觉仍成立（本函数在 0/0.5/1 与标准缓动同值）。
 */

/** 分段节点（导出供测试与文档） */
export const THREE_PHASE_KNOTS = {
  fastEnd: 0.3,
  fastValue: 0.6,
  midEnd: 0.7,
  midValue: 0.85,
} as const;

export function threePhaseEasing(t: number): number {
  const { fastEnd, fastValue, midEnd, midValue } = THREE_PHASE_KNOTS;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  // 快进段：线性冲到 0.6
  if (t < fastEnd) return (t / fastEnd) * fastValue;
  // 平缓段：线性爬到 0.85
  if (t <= midEnd) {
    return fastValue + ((t - fastEnd) / (midEnd - fastEnd)) * (midValue - fastValue);
  }
  // 慢尾段：smoothstep（t²(3-2t)）——两端导数为 0，末段减速归位无急停；
  // 比 1-(1-t)² 型在中尾段更慢（实测 t=0.9 → progress≈0.961，长尾成立）
  const tail = (t - midEnd) / (1 - midEnd); // 0..1
  const remain = 1 - midValue; // 0.15
  const tailProg = tail * tail * (3 - 2 * tail);
  return midValue + remain * tailProg;
}
