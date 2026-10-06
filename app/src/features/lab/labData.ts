/**
 * 实验室纯函数 re-export（2026-10-06）
 * ---------------------------------------------------------------
 * 历史包袱：labData.ts 原本实现聚合纯函数；2026-10-06 提升到 lib/monthlyAgg.ts
 * 给生产看板（/home）共用，避免"生产页面 import lab 模块"的依赖倒置。
 * 本文件保留 export * re-export——既有的 '@/features/lab/labData' 路径全部继续
 * 生效（tests/lab-realdata.test.ts / features/lab/useLabData.ts 等）。
 */
export * from '@/lib/monthlyAgg';