# HiFin Bento + Motion 设计语言（2026-10-06）

> **状态：看板 Bento 重构已按用户决策回退（2026-10-06）**——§3 网格与玻璃/aurora 挂载
> 已下线（Dashboard/AssistantPage/AppLayout/CommandPaletteView 恢复至 81006d3 形态，
> 见 revert 提交）。本文保留作为设计档案；Wave 1 动效基建（BentoCard/AuroraBackground/
> useInView/.glass/shadow-lift/toast 对称路径）代码保留但**无挂载点**（ dormant ），
> 若确认不再启用应删除（ponytail：不留死代码）。

> 方法论借鉴 MotionSites 的「设计语言骨架」五块结构（色板/字体/结构/动效/组件），
> 内容全部自研。动效哲学遵循 Emil Kowalski（animate 技能）：
> **不该动的绝不动，动的东西用对配料**。
> 前置决策：Bento 重构系 + 拆开部分回归闸（hover 阴影放开、装饰对比度降级；
> **reduced-motion 尊重保留**——前庭障碍是安全底线，不是美学闸门）。

---

## 1. 调色板（在既有令牌上扩展，不换语义）

| 令牌 | 值 | 用途 |
|---|---|---|
| income / expense 全套 | 不动 | 钱的颜色是品牌，前卫不碰语义 |
| brand 炭黑 | 不动 | 主按钮/强调 |
| `surface.glass` 新增 | light: `rgba(255,255,255,0.72)` + `backdrop-blur:16px`；dark: `rgba(23,26,33,0.72)` | 侧边栏、⌘K 面板、通知弹窗、toast |
| `shadow.lift` 新增 | `0 8px 30px rgba(0,0,0,0.10)`；dark `0 8px 30px rgba(0,0,0,0.45)` | bento 卡 hover 悬浮（**回归闸已放开 hover 阴影**，唯一合法来源） |
| aurora 氛围色 | 深底：emerald `#10b981` ≤8% 透明度 + 中性 slate 辉光；亮底：中性灰 ≤6% | 只看氛围，不抢数据；**aurora 永不使用饱和全色相** |

禁：紫色系、霓虹渐变文字压在读数据上、玻璃面承载正文小号字（对比度闸仍卡文字）。

## 2. 字体

不引入 webfont（ponytail：零新依赖）。前卫感靠字重/字号/字距：

- 大数字：`font-weight 700` + `letter-spacing -0.02em` + `tabular-nums`（既有）
- 净资产 hero 数字：clamp(40px, 5vw, 56px)，bento 大卡的主角
- 卡片标题：13px / 600 / muted（既有层次不动）

## 3. 结构：看板 Bento 重构

12 列网格（gap-4 既有），卡片圆角 2xl/3xl 既有：

```
┌──────────────────────────┬──────┬──────┐
│ 净资产 hero（span 8）      │ 收入2 │ 支出2 │  ← 资产概览带：hero 大卡 + 两小卡
├──────────────────────────┴──────┴──────┤
│ 资产趋势（span 8）        │ 资产分布（span 4）│
├──────────────────────┬─────────────────┤
│ 收支日历（span 6）      │ 最近交易（span 6） │
└──────────────────────┴─────────────────┘
右侧栏四卡（还款/账户/目标/预算）→ 折叠进 bento 底部一排小卡（span 3 ×4）
```

- 桌面 ≥1280px 生效；bento 之下页面（交易/账户/目标等列表页）**不动结构**，只继承动效
- 移动端 390px：单列堆叠（既有响应式约定）
- 全部既有行为保留：月份选择器/翻页、‹›、眼睛切换 MaskMoney、空态、SWR 缓存门控
- 收入/支出小卡 = 现有 StatCard 缩小版（soft 底 + deep 数字），净资产 hero = 白/玻璃大卡 + 深数字 + 环比行

## 4. 动效（extend 既有 --dur-*/--ease-*，不另起体系）

| 场景 | 决策 | 配料 |
|---|---|---|
| ⌘K 命令面板开/关 | **无动画**（100+/日 + 键盘触发，Kowalski 铁律） | 仅静态玻璃 |
| 看板/AI/发现页入场 | 首次/低频 → 允许 | fade-up（12px→0）+ opacity，stagger 40ms/step，`--dur-enter: 480ms` `--ease-out` |
| 视口外区块（折线以下） | IntersectionObserver `useInView` 一次性触发同上分入场 | 同上 |
| 卡片 hover | 每日几十次 → 轻 | `translateY(-2px)` + `shadow.lift`，`--dur-surface:160ms`，`@media (hover:hover) and (pointer:fine)` 门控 |
| 按钮 press | 反馈 | `scale(0.98)` 120ms `--dur-press` |
| toast 进/出 | 对称路径 | 滑入=滑出，`--dur-overlay:220ms`，transition 非 keyframes |
| aurora 背景 | 常驻= Always-on → 极慢漂移动 | 24s linear 位移 ±3%，reduced-motion 冻结单帧 |
| 数字滚动/图表绘制 | 既有，不动 | --dur-data / --dur-chart |
| 表单/表格行 | 数据是扫读对象，**不加装饰动效** | 仅 focus/press 反馈 |

**reduced-motion 全局降级**（保留的半闸）：所有 transform 类动效降级为 opacity-only 或冻结；
aurora 停帧；入场 stagger 保留 opacity 淡入（助于空间定位，符合"更少更温和"而非"零"）。

## 5. 组件清单（零新依赖：CSS + WAAPI + IntersectionObserver）

| 组件/钩子 | 文件 | 说明 |
|---|---|---|
| `AuroraBackground` | `app/src/components/ui/AuroraBackground.tsx` | 绝对定位渐变网格，CSS keyframes 24s drift，aria-hidden，respects reduced-motion |
| `BentoCard` | `app/src/components/ui/BentoCard.tsx` | 统一入口编排（stagger delay prop）+ hover lift + glass 可选 |
| `useInView` | `app/src/hooks/useInView.ts` | IntersectionObserver once，返回值给 BentoCard |
| `GlassPanel` | 样式类 `.glass`（index.css） | backdrop-filter + surface.glass；含 `backdrop-filter` 不支持时的 @supports 回退 |
| 回归闸更新 | `accept/scripts/design-consistency.mjs` / `darkmode-audit.mjs` | hover 阴影断言反转（只允许 shadow.lift 经 BentoCard）；装饰性元素对比度降级 advisory；文字对比度闸保持 |

## 验收

1. `tsc --noEmit` + vitest 全过；`design-consistency`/`darkmode-audit` 更新后全过
2. 桌面 /home bento 截图 + 390px 移动端截图 + 暗色截图（accept/screenshots/bento-motion/）
3. 动效手感自查清单：DevTools 动画检查器 stepping；reduced-motion 模拟（DevTools Rendering 面板）确认降级
4. ⌘K 开关确认无动画
