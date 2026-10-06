/**
 * recharts 系列色（与 tailwind.config.js 的 token 同源，单独导出是因为
 * recharts 的 fill/stroke 接受 JS 字面量，无法直接消费 Tailwind 类）。
 *
 * ponytail: 这是 token 的 JS 镜像，不是新色板。改 tailwind 主题色时务必
 * 同步改这里——小代价是双写，比每张图表各自 `#xxx` 硬编码少一处真相。
 */
export const CHART_COLORS = {
  /** brand 炭黑：净资产趋势 / 概览线（非收支数据） */
  brand: '#26262b',
  /** income 绿：正向金额（收入 / 预算剩余） */
  income: '#10b981',
  /** expense 红：负向金额（支出 / 超支） */
  expense: '#ef4444',
} as const;
