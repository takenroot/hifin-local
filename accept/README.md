# accept/ — 验收产物

本目录存放项目验证相关的产物。原则：**`scripts/` 与 `screenshots/` 只放可复跑的回归脚本及其产物；一次性的历史迭代验证全部下沉到 `archive/`（只读）。**

## 目录结构

```
accept/
├── scripts/                       # 可复跑回归脚本（7 个，唯一维护面）
│   ├── design-consistency.mjs     # 6 列表页设计一致性
│   ├── darkmode-audit.mjs         # 暗黑模式对比度审计
│   ├── dexie-purge-smoke.mjs      # Dexie 移除后 REST 冒烟
│   └── weather-city-persist.mjs   # 天气城市选择持久化
├── screenshots/                   # 活跃截图产物（一个脚本一个子目录）
│   ├── darkmode-audit/            #   18 PNG + issues.json（对比度问题清单）
│   ├── design-consistency/        #   18 PNG（空态 / 有数据态 × 亮/暗）
│   ├── dexie-purge/               #   4 PNG
│   └── space-rest-fix/            #   6 PNG（空间隔离修复一次性留档，无对应脚本）
└── archive/                       # 一次性历史产物，只读，不再更新
    ├── scripts/                   #   19 个 R2-R8 / wave2 一次性验证脚本
    └── screenshots/               #   根目录散图 32 张 + 6 个历史子目录
        ├── dark/                  #     5 张  暗黑模式
        ├── final/                 #     3 张  R6 收尾
        ├── flows/                 #     7 张  E2E 交互流程
        ├── iterations/            #     4 张  R5 新模块
        ├── mobile/                #     9 张  移动端 390px
        └── pages/                 #    11 张  桌面各页
```

## 运行环境

- **Playwright 1.55.0** 装在仓库根 `node_modules/playwright`，浏览器在 `~/.cache/ms-playwright/`。
  脚本统一从仓库根 `node_modules` 解析（`dexie-purge-smoke.mjs` 走绝对路径导入，效果等价）。
- **Chromium Headless Shell 已就绪**，**不要**执行 `npx playwright install`。
- 首次在新机器上拉起时才可能需要补装；本机已具备。

## 端口约定

| 端口 | 用途 |
|---|---|
| `8787` | core REST 服务（常驻，不随脚本重启） |
| `5185` – `5190` | 脚本自用的 vite dev server，**逐个脚本错开**避免互相抢占 |
| `5199` | 用户预览实例，**脚本不得占用** |

启动 dev server（把端口换成该脚本默认的那个）：

```bash
cd app
npm run dev -- --port 5185 --strictPort --host 127.0.0.1 &
```

清理时只按端口精确杀，**禁止** `pkill -f vite`：

```bash
pkill -f "vite.*5185"
```

## 回归脚本

> 所有脚本都应在**仓库根目录**运行（`node accept/scripts/<name>.mjs`）：多数脚本的截图输出路径是相对仓库根的。

### 1. `design-consistency.mjs` — 6 列表页设计一致性

覆盖 7 个验收点：PageHeader 常驻 primary 按钮、无死按钮图标（IconShare/IconEye）、
空状态统一 `EmptyStateCard`、网格 `gap-4`、无 `hover:shadow-md`、内容最大宽度 1400px、
暗黑模式 `html.dark` 生效。**108 条断言**。

- 端口：`BASE_URL` 默认 `5185`，`CORE_URL` 默认 `8787`
- 写数据策略：账户/流水用真实数据；预算/目标/报表临时 POST fixture 后 DELETE 复原；
  空状态用 Playwright 路由拦截把 `/api/*` 打回 `[]`，零写入
- 输出：`accept/screenshots/design-consistency/`（18 PNG）

```bash
BASE_URL=http://127.0.0.1:5185 CORE_URL=http://127.0.0.1:8787 \
  node accept/scripts/design-consistency.mjs
```

### 2. `darkmode-audit.mjs` — 暗黑模式对比度审计（只读）

强制暗黑模式（`localStorage hifin:theme="dark"` + `emulateMedia`），
系统性扫描 **9 个页面 + 8 个 Modal** 的文字 / placeholder / 边框 / 图标对比度。

- 判定口径写入 `issues.json` 的 `meta.thresholds`：
  - 文字/placeholder/图标：`< 3.0` = issue（不可见），`< 4.5` = advisory
  - 边框（WCAG 1.4.11 非文本）：`< 1.5` = issue（太淡），`< 3.0` = advisory
  - 对比度 `(L1+0.05)/(L2+0.05)`，背景色向上遍历祖先链合成 effective background
- 已知取舍（同样写进 `meta`）：`opacity:0` 的 hover 按钮记 `hiddenByOpacity` 不算 issue；
  `text-transparent` 占位记 `intentionallyTransparent` 不算 issue
- **不改任何业务代码**，可反复跑，适合改配色后做对比度回归
- 端口：`HIFIN_BASE` 默认 `5185`
- 输出：`accept/screenshots/darkmode-audit/`（18 PNG + `issues.json`）

```bash
HIFIN_BASE=http://127.0.0.1:5188 node accept/scripts/darkmode-audit.mjs
```

### 3. `dexie-purge-smoke.mjs` — Dexie 移除后 REST 冒烟

验证前端移除 Dexie/IndexedDB 后仍能纯 REST 取数渲染：/home、/account/list、
/transaction、/settings。每页收集 console error / pageerror / 失败请求，
并断言正文有实际内容。

- 已知例外：`core` 的 `GET /api/kv/:key` 对未设置的 key 返回 **404**（直连 8787 同样 404，
  属服务端 by-design 行为），该 404 在白名单内单独统计、不计失败
- 端口：默认 `5187`（脚本内硬编码）
- 输出：`accept/screenshots/dexie-purge/`（4 PNG）

```bash
node accept/scripts/dexie-purge-smoke.mjs
```

### 4. `weather-city-persist.mjs` — 天气城市选择持久化

验证「用户选的城市不被浏览器定位覆盖」：选呼和浩特 → 刷新 → 仍是呼和浩特。
只读断言，不写业务数据，不产生截图。

- 端口：`HIFIN_BASE` 默认 `5185`

```bash
HIFIN_BASE=http://127.0.0.1:5189 node accept/scripts/weather-city-persist.mjs
```

### 5. `border-contrast.mjs` — 暗黑边框对比度（WCAG 3:1）

断言 `border.dark` token 在实际渲染中对页面底 `#0f1115` 与卡片底 `#171a21`
均 ≥ 3:1（WCAG 1.4.11）。强制暗黑模式访问 /home、/account/list、/transaction、
/settings，用 getComputedStyle 抽取真实 border-color 并沿祖先链合成背景。

- 端口：脚本内默认 `5188`
- 输出：`accept/screenshots/border-contrast/`（明暗各 4 PNG）

```bash
node accept/scripts/border-contrast.mjs
```

### 6. `no-empty-flash.mjs` — 列表页空态闪烁回归

用 Playwright route 延迟（非 CDP 限速——需要「空态出现时刻晚于数据请求放行」
的精确边界）断言：/transaction、/account/list、/budget 加载期间
EmptyStateCard 与「暂无」文案**零帧出现**；二次访问首帧即渲染缓存数据（SWR）。

- 端口：脚本内默认 `5186`
- 输出：`accept/screenshots/no-empty-flash/`（9 PNG）

```bash
node accept/scripts/no-empty-flash.mjs
```

### 7. `tx-grouping-stats.mjs` — 流水分组与统计 Tab

日/周/月/年四档分组 + 分组小计、维度与统计月份的 localStorage 持久化、
统计 Tab 饼图/排行/月份翻页/明暗双主题。**72 条断言**。

- 端口：脚本内默认 `5189`
- 输出：`accept/screenshots/tx-grouping-stats/`（22 PNG）

```bash
node accept/scripts/tx-grouping-stats.mjs
```

## archive/ 说明

`archive/` 收录 **R2–R8 / wave2** 各轮一次性验证脚本与其截图产物，仅作历史留档。

- 归档脚本里的截图输出路径仍是**归档前**的 `accept/<name>.png` / `accept/screenshots/<子目录>/`，
  **没有回改**——直接重跑会写到旧路径。如需复现某一轮，请按需把脚本挪回 `scripts/` 并改输出目录。
- 所有归档文件均用 `git mv` 移动，历史（`git log --follow`）保持连续。
- 已知取舍：`screenshots/space-rest-fix/` 按要求保留在活跃区，但它没有对应脚本
  （空间隔离修复的一次性留档），不会被任何脚本重新生成。
