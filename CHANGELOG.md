# 变更日志

本项目的所有重要变更按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录，版本与 git 提交一一对应。

## [unreleased]

### 新增（core 账单自动化，2026-10-02 密集迭代）
- **hifin-core 骨架**：Node + Express + better-sqlite3（WAL）+ imapflow + adm-zip + commander
- **REST API 14 资源**：accounts/transactions/categories/summary/goals/budgets/tags/merchants/rules/reports/spaces/kv/ai-models/notifications
- **CLI**：`serve` / `accounts` / `tx` / `summary` / `import-csv` / `import-bill` / `mail config` / `mail poll`
- **IMAP 轮询**：QQ 邮箱 → 检测账单邮件 → 支付宝直接下载附件 / 微信提取 URL 下载
- **账单解析**：ZIP 解密（ZipCrypto）→ GBK CSV 解码 / **xlsx 转 CSV**（微信账单是 Excel）→ parseCsvText → 事务入库 + 余额联动
- **通知系统**：need_password → 用户提交密码 → 3 次重试状态机 → failed 降级；前端 30s 轮询 + Modal 密码输入
- **微信 URL 提取**：MIME base64 解码 → HTML `<a>` 标签提取 → 中转页参数解包
- **数据迁移**：Web SPA 全面切 REST（8 feature 目录，激进迁移，IndexedDB 废弃）
- **样式**：收入=红色、支出=绿色（用户直觉，tailwind 色板交换）

### 真实数据验证
- 支付宝：317 笔自动导入（IMAP 附件下载 → GBK CSV → 入库）
- 微信：500 笔自动导入（URL 下载 → xlsx → CSV → 入库）
- 余额联动：支出扣减 / 收入增加，事务内完成

### 文档
- README.md 全面重写（架构图 + 快速开始 + 数据现状）
- docs/known-issues.md：ISSUE-001（微信 URL 4字节假文件）、ISSUE-002（Tailwind 缓存）
- docs/bill-automation-design.md：账单自动化设计（Mermaid 架构/时序/状态机）

### 路线图（下一步）
- IDLE 长连接替代轮询（秒级通知）
- Tauri 桌面 App（系统通知 + 开机自启）
- AI 分析引擎（LLM 生成财务建议）
- MCP server 模式（AI Agent 直接调用）

---

## [0.3.1] - R7/R8 UI 打磨 - 2026-09-27

提交：`ad1b92a`、`da348e4`

### 新增 / 变更
- **R7**：看板顶栏眼睛图标改为切换金额显隐（localStorage 持久化，MaskMoney 组件覆盖三卡/还款提醒/账户卡/最近交易）；分享图标删除
- **R7**：设置页「保存」按钮竖排文字修复（`whitespace-nowrap` + `min-w-[80px]` + disabled 灰化）
- **R7**：主题选择改 3 个 pill 选项；「分组」标题样式强化
- **R7**：`Tabs` 组件修复 `items[].content` 不渲染的 bug（交易导入空白页根因）
- **R8**：`Select` 组件彻底重写为自定义弹层（告别原生 `<select>`），API 完全向后兼容；卡片式圆角弹层 + 内部滚动 + 键盘导航 + 暗黑模式全套

---

## [0.3.0] - R6 迭代 - 主题/多空间/移动端/发现 - 2026-09-27

提交：`8319bbf`

### 新增
- **主题跟随系统**：`themeAtom` 支持 `light`/`dark`/`system`；ThemeProvider 通过 `matchMedia` 实时跟随操作系统偏好；HTML 防闪烁脚本适配 system 模式
- **多空间隔离**：新增 `spaces` 表（Dexie v4），账户/流水/目标/预算支持 `spaceId` 字段；`useSpaceId()` + `filterBySpace()` helper；空间切换器支持创建/切换/全部空间；存量数据自动归默认空间
- **报表自定义**：扩展 `reports.config` JSON 数据范围 + 4 种图表组件多选；老报表模板逻辑向后兼容
- **移动端响应式**：侧边栏 lg 断点抽屉化（汉堡按钮 + 遮罩）；`PageHeader`/网格/表格/Modal 全面响应式；390px 下 9 个页面零横向滚动
- **发现页**（`/discover`）：本地数据洞察 —— 本月支出环比、储蓄率、连续记账天数、单笔最大支出、TOP3 分类；预算超支提醒、目标临期提醒；财务小贴士静态卡
- **天气**：Open-Meteo 免费 API（无需 key）接入看板欢迎区；浏览器定位 3s 超时 + 6 城市预设 + 30 分钟缓存 + 离线静默

### 变更
- ⌘K 「新建账户」快捷键 `a` → `n`（避免与 AI 助手 `a` 冲突）
- 侧边栏「预算」「发现」默认显示
- 看板欢迎区追加天气 + 城市切换小齿轮

### 技术债务
- `vendor-recharts` 仍为 422KB 单 chunk（受依赖体积限制）

---

## [0.2.0] - R5 迭代 - 预算/规则/AI 助手/工程化 - 2026-09-27

提交：`6711d6b`

### 新增
- **预算模块**：Dexie v2 迁移（`budgets` 表）；`/budget` 页面 CRUD；按分类/周期实时聚合已花；超支红色警示；侧边栏导航接通；报表"预算执行"模板接真实数据
- **交易规则引擎**：`rules` 表（Dexie v3）；按关键词/优先级/大小写不敏感自动归类；设置页真实 CRUD；CSV 导入与新建流水时实时建议
- **AI 助手**（`/ai`）：OpenAI 兼容端点本地接入；财务概况聚合上下文；会话持久化（kv 表，最多 20 条）；⌘K 快捷键 `a`；模型「设为默认 / 测试连接」；未配置模型零请求

### 工程
- **单元测试**：Vitest + fake-indexeddb，52 例全绿（balance / CSV / dashboard-calc / db-seed）
- **代码分割**：Vite `manualChunks` 拆分 vendor（react/dexie/recharts/utils），最大 chunk 902KB → 422KB
- **默认登录页生效**：`App.tsx` 读取 `defaultPageAtom`，设置页改动即时反映
- **空状态插画升级**：`EmptyState` 默认 SVG 替换为手绘账本钱包风格（明暗自适应）

---

## [0.1.0] - 初始复刻 - MVP 8 项 - 2026-09-27

提交：`01f087d`

### 范围
对照 [`hifin-features.md`](../hifin-features.md) 第十二章 MVP 清单完成：

- 看板 Dashboard（资产概览/趋势/分布/日历）
- 账户管理（两步创建/列表/详情）
- 交易流水（四类/筛选/余额联动/CSV 导入）
- 目标管理（两步创建/进度/存取联动）
- 分类/标签/商户 CRUD（本地）
- 账单导入（CSV 解析）
- 基础设置（主题/语言/默认页/菜单显隐）
- ⌘K 命令面板

### 技术决策
- 删除 HeroUI（依赖重、风险高），改用 Tailwind + 自建 UI 组件库
- `import.meta.glob` 自动路由注册替代手动维护路由表
- Dexie 增量迁移 + `ensureSeed` 幂等初始化
- 文件名沿用项目原有 `hifin-*` 探索资料命名（待后续整理）—— 见 `unreleased` 段

---

## 未来计划

- i18n 全量翻译（接入 i18next，工程量大）
- 报表可视化编辑器（拖拽组件）
- E2E 测试固化进 `tests/`
- 进一步拆分 `vendor-recharts`（按路由懒加载）