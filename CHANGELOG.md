# 变更日志

本项目的所有重要变更按 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格记录，版本与 git 提交一一对应。

## [unreleased]

### 文档与整理
- 项目结构整理：探索原始资料归档至 `docs/exploration-originals/`，删除冗余探索工具
- 新增根 `README.md`、`app/README.md`、`CHANGELOG.md`（本文档）
- `accept/` 重组：脚本与截图按类型分目录，移除端口重命名重复件
- `.gitignore` 补全（`*.tsbuildinfo`、`.vite/`、`.env*` 等）

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