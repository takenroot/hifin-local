# ui-refresh/ — 看板英雄化 + 卡片分层 + 预算卡接真数据（验收截图）

一次性验收产物（非回归脚本产物；本轮没有新增/修改 `accept/scripts/` 下的脚本）。
采集方式：core :8787 + vite :5185 自查端口，Playwright 强制主题（`hifin:theme`），
viewport 1440×1000 与 390×844，截图前 `networkidle` + 1.2s 落定。
预算两态用 `page.route` mock `/api/budgets`（零写库），游标数据取默认空间真实账户/流水。

| 文件 | 视口 | 主题 | 预算卡 | 看点 |
|---|---|---|---|---|
| `before-dashboard-1440-light.png` / `before-dashboard-1440-dark.png` | 1440 | 明亮 / 暗黑 | 占位「敬请期待」 | **改动前**基线：同质白卡 + text-2xl 金额 + 环比徽章 |
| `dashboard-budget-data-1440-light.png` / `-dark.png` | 1440 | 明亮 / 暗黑 | 有数据（3 条） | 色块三卡：净资产 brand.soft + 3px brand 边条主卡，28px 金额 |
| `dashboard-budget-data-390-light.png` / `-dark.png` | 390 | 明亮 / 暗黑 | 有数据（滚动到卡片） | 移动端单列不破版，横向溢出 0px |
| `budget-empty-1440-light.png` / `-dark.png` | 1440 | 明亮 / 暗黑 | 空态 | 空态文案改「设置本月预算」，整块可点跳 `/budget` |
| `budget-empty-390-light.png` / `-dark.png` | 390 | 明亮 / 暗黑 | 空态 | 移动端空态 |
| `transaction-1440-light.png` / `-dark.png` | 1440 | 明亮 / 暗黑 | — | 交易页合计卡同层级：方向色块、无边框、圆角 3xl |
| `transaction-390-light.png` / `-dark.png` | 390 | 明亮 / 暗黑 | — | 390px 合计卡金额保持 text-xl（≥640 才升 2xl） |
| `before-transaction-1440-light.png` | 1440 | 明亮 | — | **改动前**基线：合计卡还是白卡（`card`） |

同轮跑通的回归闸（结果见仓库根 README / 交付说明）：
`design-consistency` 108/108 · `darkmode-audit` 0 新增问题 · `no-empty-flash` 0 失败 ·
`border-contrast` PASS（契约边框样本 29 → 27：看板三卡去掉边框，样本相应减少）。
