# 设计审查报告(2026-10)

**审查时间**：2026-10-05
**审查版本**：`24422a4` refactor: 年收益率(%)→年度收益金额(元)语义重构(v3→v4)
**审查性质**：只读。本次审查**未修改任何产品代码**，`git status` 除本文件外为空。
**审查工具**：impeccable 4.5.0 · web-interface-guidelines · improve-animations · impeccable 确定性检测器(61 条规则)

---

## 0. 审查方法与可信度

本次审查用 **4 个互相隔离的并行子代理**完成,互相看不到对方的输出,避免锚定效应:

| 代理 | 承担的检查 | 独立性保证 |
|---|---|---|
| A | impeccable `critique` — 设计总监视角的 UX/视觉评审 | **未运行检测器**,未读其输出 |
| B | impeccable `audit` — a11y/性能/主题/响应式/实现完整性 + 检测器 | 独立运行检测器并逐条在代码中验证 |
| C | web-interface-guidelines — 16 条规则域 + 16 条反模式逐条比对 | 独立取证 |
| D | improve-animations — 动效全量盘点与改进计划 | 独立取证 |

主会话另外独立完成了两项不与上述重叠的检查(导航激活态缺陷、构建产物构成)。

**未做的事(重要限制)**:

- **本会话没有浏览器自动化**。所有关于焦点环、渲染后对比度、触摸手势、实际动效手感的判断,都是从源码与 Tailwind 语义推导的,不是观察到的。下方标「需真机验证」的条目必须人工过一遍再定级。
- **视觉基准图已过期**。`docs/exploration-originals/*.png` 拍摄于 2026-08-20,比当前代码早约 6 周,三个独立证据表明它属于上一代设计(见 §5.6)。A 代理据此给出的视觉判断,凡与代码冲突处均以代码为准。**暗色模式没有任何基准图,视觉层面完全未验证。**
- **检测器不是审计**。61 条确定性规则在 21,682 行源码上只命中 **1 条**;本报告的 30+ 条问题里,没有一条是检测器独立发现的。检测器的盲区是语义与对比度:`opacity-0` 可达性、颜色对比、对话框焦点管理、标题层级、令牌绕过,全部不查。

---

## 1. 结论摘要

这是一个**工程质量明显高于设计成熟度**的项目。

`tailwind.config.js:17-21` 里那段把暗色边框推导到 3.09:1 并写出完整算式的注释,`Select.tsx` 378 行带完整 ARIA combobox 语义的实现,`EmptyState.tsx:22-97` 用 `currentColor` 手绘的账本插画,`SegmentedControl.tsx:4-10` 写明「为什么它必须从 Tabs 里分叉出来」的注释——这些都是 senior 级别的作品,不是模板套壳的产物。

但把四份独立评审交叉对齐后,暴露出一条极其一致的系统性断裂:

> **基础组件的质量与它的使用频次成反比。**
>
> `Select`(用了 1 次)做到了教科书级别;`Modal`(用了 **28 次**)没有任何对话框语义、焦点陷阱、焦点归还;`Switch`(5 处调用)**在暗色模式下开启态对比度 1.09:1——等于看不见**,而且组件的 props 里根本没有 `aria-label`,5 处调用全部无名。

配套的第二个断裂:

> **令牌配对只调校了暗色那一半。** 暗色边框有发布的对比度算式,亮色边框 1.19:1;暗色正文 14:1,`text-expense` 亮色 2.54:1。作者验证了他们看得见的那一个主题。

第三个断裂(本次审查新发现,四份评审均未提及):

> **侧边导航的激活态在三个路由上失效。** 点进任一账户或报表的详情页,侧边栏不再高亮任何一项。见 §2.1。

### 评分

| 量表 | 分数 | 含义 |
|---|---|---|
| **Audit Health Score**(a11y 1 · 性能 2 · 主题 2 · 响应式 2 · 完整性 3) | **10/20** | Acceptable — 需要实质性工作 |
| **Nielsen 10 启发式** | **22/40** | Acceptable — 真实界面多在 20-32 |
| **Implementation Integrity 判定** | **PASS(带 3 处可验证漂移)** | 表达连贯且产品专属 |
| **web-interface-guidelines 合规度** | **~70%** | 视觉/排版层强,无障碍与对话框层不可发布 |

**总问题数 32**:P0 ×2 · P1 ×11 · P2 ×15 · P3 ×5(另含本报告新发现 1 项,按 P1 计入)

---

## 2. 分级问题总表(交叉验证后)

「验证」列 = 有几个独立来源确认该问题存在。

| # | 优先级 | 问题 | 位置 | 验证 |
|---|---|---|---|---|
| 1 | **P0** | `income`/`expense` 令牌兼任 UI 危险/错误通道 → **12 个「确认删除」按钮是绿色的,表单报错是绿色的,必填星号是绿色的** | `tailwind.config.js:29-39` · `Button.tsx:21` · `Input.tsx:21` | A · B |
| 2 | **P0** | 交易行的编辑/删除只在 hover 显示,无 `focus-within`、无移动端兜底;`opacity:0` 仍可命中 → **触摸设备上零反馈即可触发删除** | `TransactionListView.tsx:473-491` | B · C · D |
| 3 | **P1** | 共享 `Modal` 无 `role="dialog"` / 无 `aria-modal` / 无焦点陷阱 / 无焦点归还,**28 个调用点** | `Modal.tsx:47-79` | B · C |
| 4 | **P1** | 命令面板 Esc 不生效(注释称由 Modal 提供,但它根本没用 Modal);声明了 `aria-modal` 却没有模态性;无 `aria-activedescendant` | `CommandPaletteView.tsx:96-119,147-167` | A · B · C |
| 5 | **P1** | 全应用仅 1 处 `htmlFor`;`Field` 渲染 `<div>` 或无关联的 `<label>` → **记账表单 9 个控件全部无程序化标签** | `TransactionFormModal.tsx:546-553` 等 4 处 | B · C |
| 6 | **P1** | 12 个页面无 `<h1>`,标题是 `<div>`;`SettingsPage` 的层级还是反的 | `PageHeader.tsx:31` · `SettingsPage.tsx:78` | B · C |
| 7 | **P1** | `Switch` 暗色开启态 `#171a21` on `#171a21` = **1.09:1**;且组件无法接受 `aria-label` | `Switch.tsx:3-9,32,40` | B · C |
| 8 | **P1** | `text-expense` 2.54:1(102 处)、`text-income` 3.76:1(47 处)、亮色 `border` 1.19:1 → **全站 WCAG AA 不合格** | `tailwind.config.js:16,31,36` | B |
| 9 | **P1** | 图表无任何无障碍替代;`index.css:42-47` 的注释所依据的 `accessibilityLayer` **从未启用** | `index.css:42-53` | B · C |
| 10 | **P1** | 侧边导航激活态在 `/account`、`/account/detail/:id`、`/report/detail/:id` 失效;移动端标题退化为「HiFin」 | `AppLayout.tsx:163,285` | **本报告新发现** |
| 11 | **P1** | 无路由级代码分割,`vendor-recharts` 占 gzip 总体积 **41%**,首屏必下 | `App.tsx:21-24` | B |
| 12 | **P1** | 命令面板展示 5 个未绑定的快捷键提示;`预算`/`发现` 两条都跳 `/home` | `items.tsx:28,42-66,106-118` | A |
| 13 | **P2** | 无 CSS 级 `prefers-reduced-motion`;12-16 个无限动画(骨架屏 pulse / Spinner spin / 打字点 bounce)不受系统设置约束 | `index.css` 全文 | B · C · D |
| 14 | **P2** | recharts 默认 `animationDuration:1500`,8 个图表 / 12 条 series 全部吃默认值 | `ReportDetail.tsx` 等 | D |
| 15 | **P2** | `分类` 下拉 135 个选项平铺在**使用频率最高**的界面上,无搜索无分组 | `TransactionFormModal.tsx:150-171` | A |
| 16 | **P2** | 18 个通用组件、0 个领域组件;`formatMoney` 在 6 处重复实现且已经开始互相矛盾 | `dashboard/format.ts:8` · `accounts/format.ts:58` | A · C |
| 17 | **P2** | `dark:text-[#a5b4fc]` 硬编码 12 次;`Badge` warning 色未进令牌 | 9 个文件 | A · B |
| 18 | **P2** | 死代码 `layout/CommandPalette.tsx`(97 行)仍留在树里 | `layout/CommandPalette.tsx` | B |
| 19 | **P2** | `PIE_COLORS` ×3、`Field` ×4、`DeleteConfirmModal` ×4 各自重复;四个 `Field` 的注释逐字重复(复制粘贴的指纹) | 多处 | B |
| 20 | **P2** | 设置页向用户暴露开发者字符串:`English（占位）`、`日本語（占位）`、`敬请期待`、`（占位）` | `menu.tsx:105-106` 等 | A · B |
| 21 | **P3** | `ProgressBar` 用 `transition-all` 动 `width`(布局属性) | `ProgressBar.tsx:37` | B · C · D |
| 22 | **P3** | `text-[10px]` px 绝对值不随浏览器字号缩放 | 4 处 | B |
| 23 | **P3** | `h-screen/w-screen` 无 `dvh`、无 `env(safe-area-inset-*)` | `AppLayout.tsx:134` | B |
| 24 | **P3** | 4 处 `transition` 声明挂在无 hover/active/focus 的元素上(死声明) | `GoalList.tsx:241` 等 | D |

---

## 3. 详述

### 3.1 【新发现】侧边导航激活态在详情页失效

**位置**:`app/src/layout/AppLayout.tsx:285`(激活判定)、`:163`(移动端标题)

```tsx
const active = pathname.startsWith(it.to);
```

`it.to` 的取值是 `/home` · `/account/list` · `/transaction` · `/budget` · `/goal/list` · `/report/list` · `/discover`(`AppLayout.tsx:96-102`)。而 `accounts/routes.tsx:12,15` 还注册了 `/account` index 路由和 `/account/detail/:id`,`reports/routes.tsx` 同理。

字符串前缀匹配的后果:

| 路径 | 侧边栏激活项 | 移动端标题 |
|---|---|---|
| `/account/list` | 账户 | 账户 |
| **`/account`** | **(无)** | **HiFin** |
| **`/account/detail/3`** | **(无)** | **HiFin** |
| **`/report/detail/7`** | **(无)** | **HiFin** |

**可达性已确认**:`AccountList.tsx:235` 点击账户卡片 → `/account/detail/${id}`,`ReportList.tsx:97` 点击报表 → `/report/detail/${r.id}`。这两个都是主流程里的正常操作。

**用户感知**:点进一个账户详情,侧边栏「账户」不再高亮——用户失去了「我在哪个模块」的定位信息。在宽屏下页面标题由 `AccountDetail.tsx:108` 的 `PageHeader title="账户详情"` 正确渲染,所以桌面端只是失去导航上下文(P1);`lg:hidden` 的移动端顶栏(`AppLayout.tsx:162-164`)会直接显示「HiFin」,连模块名都丢了(P2)。

**修法**(一处,两行收益):把 `to` 改为段前缀 `/account` / `/report` / `/goal`,并用段感知匹配替代裸 `startsWith`:

```tsx
const active = pathname === it.to || pathname.startsWith(it.to + '/');
```

或者保持 `to` 不变,改用 `useMatches()` 读 react-router 已解析的匹配结果——这是 ponytail 阶梯第 2 级(复用已有能力)而不是第 7 级(自己写一套)。

### 3.2 【P0】`expense` 绿色令牌的三重职责

`tailwind.config.js:29` 的注释写着「收入=红色(用户直觉),支出=绿色」——这是中国市场惯例,方向正确,`accounts/format.ts:8-9` 也写明了理由。问题在于**同一对令牌同时被接到通用 UI 状态上**:

| 表现 | 位置 |
|---|---|
| 12 个 `variant="danger"` 按钮渲染为**绿色** | `Button.tsx:21` → 各 feature 的 `DeleteConfirmModal`、`SecuritySection.tsx:248,290`、`TagsSection.tsx:321`、`RulesSection.tsx:447` 等 |
| 表单非法输入框是**绿色边框** | `Input.tsx:21` |
| 校验错误横幅是**绿色** | `TransactionFormModal.tsx:339` · `TransactionImportView.tsx:339` · `GoalFormModal.tsx:231,192` 等 6 处 |
| 必填字段星号 `*` 是**绿色** | `GoalFormModal.tsx:581` |
| **成功 toast 是红色,错误 toast 是绿色** | `NotificationCenter.tsx:476` |
| 资产分组标题红、负债分组标题绿 | `AccountFormModal.tsx:293,304` |

最后一行尤其反直觉:**你欠的债越多,界面越绿。**

**根因不是选错颜色,是少了一条语义轴。** 领域语义(收入/支出)和 UI 状态语义(危险/成功/中性)是两个正交维度,现在被压进了同一对十六进制值。

**修法**:新增 `--danger` / `--danger-soft` / `--success` 令牌专供 UI 状态,`income`/`expense` 严格只管钱;然后把 `Button.tsx:21`、`Input.tsx:21`、6 个错误横幅、必填星号、行内删除按钮 hover、`NotificationCenter.tsx:476` 指过去。`Badge.tsx:17` 已经有一个从未被用上的 `warning` 黄色调,正好接删除警告面板。

### 3.3 【P0】悬停专属的删除操作

```tsx
// TransactionListView.tsx:473
<div className="flex-none flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
```

三个问题叠在一起:

1. **触摸设备上永不出现**。全仓库零 `group-focus-within`、零 `sm:`/`md:` 常显变体(唯一的 `focus-within:` 在 `Input.tsx:20`,与此处无关)。
2. **`opacity:0` 不禁用命中测试**。`TransactionListView.tsx:375-491` 的每一行右侧都留着一块约 58×26px 的活区,拇指划屏停在那里就会**无任何视觉反馈地触发删除**。
3. 行本身是个纯 `<div>`(`:377`),不是按钮也不是链接,没有任何替代入口。

删除一条交易是记账软件的主流程动作。修法一行:

```
opacity-100 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100
```

外加给两个图标按钮补 `aria-label`(现在只有 `title`,触屏永远读不到)。`AccountList.tsx:256` 的箭头是同一个毛病但只影响可发现性,降为 P3。

### 3.4 【P1】Modal 与命令面板的对话框契约

**`Modal.tsx:47-79` 缺什么**:`role="dialog"`、`aria-modal`、`aria-labelledby`、初始焦点、Tab 循环、关闭后焦点归还、关闭按钮的 `aria-label`。28 个调用点,也就是全应用每一条数据录入路径。

实际后果:打开表单后焦点仍留在遮罩**后面**的触发按钮上,Tab 会走到背后的页面(账户表单的 Tab 会一路走进看板的日历按钮);关闭后焦点掉回 `<body>`,用户丢失位置;屏幕阅读器完全没有「对话框打开了」这个播报。

同仓库的 `CommandPaletteView.tsx:148-149` **反而设置了** `role="dialog" aria-modal="true"`——但它没做焦点陷阱,于是它**宣称**了模态性却不是模态。对照组成立:同一个代码库,做对的那个不是表单。

命令面板另外三个问题(C 与 A 独立发现):

- **Esc 不生效**。`CommandPaletteView.tsx:96` 的注释写「这里仅响应 Esc(Modal 内置)」,但该组件 `:141-156` 自己手写了 portal 和遮底,**根本没用 `Modal`**;`onKeyDown` `:98-119` 只处理 ↑↓ Enter。全应用唯一的 Esc 绑定是 `Modal.tsx:35` 和 `Select.tsx:202,246`。用户用 ⌘K 打开面板,按最标准的关闭键,什么都不会发生——只能点遮罩,或者误执行当前高亮的那条命令。
- **5 个未绑定的快捷键**。`items.tsx:42,50,58,66,126` 声明 `shortcut: 't'|'n'|'c'|'a'|'s'`,`:224-228` 把它们渲染在行右侧,`items.tsx:28` 的注释诚实承认「仅展示」。全应用只绑了 ⌘K 一个键(`AppLayout.tsx:69-78`)。
- **两条命令跳错页**。`items.tsx:106-118` 的 `预算` 和 `发现` 都是 `to: '/home'`,静默失败且无任何反馈。

**修法**:把 `Modal` 补成真正的对话框(这是本报告中投入产出比最高的一处——一处改动修好 28 个调用点);命令面板加 Esc 分支;要么真的绑定那 5 个键,要么删掉 `shortcut` 字段及其渲染。

### 3.5 【P1】`prefers-reduced-motion`:对的地方和错的地方

**先修正审查前提**:本次审查最初假设「全项目零 `prefers-reduced-motion`」,**这是错的**。`app/src/hooks/useAnimatedNumber.ts:17-25` 有一个实现正确的守卫,而且这个 hook 同时处理了中断(`fromRef` 从当前值续跑而非跳变)和清理(取消 rAF)——大部分 count-up hook 这两处都写错。它是全仓库最好的动效实现。

但 **CSS 层面零 `prefers-reduced-motion`**:`app/src/index.css` 全文 53 行没有任何 `@media` 块。后果是精确的反过来的:

> 有限的、有界的 700ms 数字滚动 —— 降级了。
> 无限的、无界的骨架屏 pulse / Spinner spin / 打字点 bounce —— 12 到 16 处,一个都没降级。

而 WCAG 2.2.2(Pause, Stop, Hide)与 2.3.3 管的恰恰是后者。精力花在了风险最低的那个动画上。

有一个细节值得单独说:**`animate-spin` 不该被一刀切停掉**。16px 的圆环是长耗时场景里唯一的进度信号,停掉它会让用户以为界面卡死。正确做法是只对 `animate-pulse` / `animate-bounce` 加 `animation: none`,保留 spin。

### 3.6 基准图已过期(影响一切基于它的视觉结论)

四个来源独立确认。三条硬证据:

1. `hifin-setting-preference.png` 显示主题是单个开关;`PreferencesSection.tsx:74-101` 实现的是三选一 radiogroup(浅色/暗黑/跟随系统)。
2. 同一张图显示绿色 Switch;`Switch.tsx:32` 是单色(`bg-text` / `bg-border`)。
3. `hifin-categories.png` 两列都叫「分类数量」;`CategoriesSection.tsx:108-109` 是「分类数量」和「分组数量」。

我另外用时间戳独立确认:基准图 mtime 为 2026-08-20,`AppLayout.tsx` 最后一次提交是 2026-10-02,相差约 6 周。我在 `hifin-cdp-account-list.png` 里还看到侧边栏「交易」项带一个 `+` 快捷入口,而当前 `AppLayout.tsx:287-299` 的导航项**根本不渲染 `+`**——直接证明截图与代码不是同一代。

**建议**:要么按当前构建重新生成基准图,要么在 `docs/exploration-originals/` 加一个 README 写明拍摄日期与其对应的令牌版本。在那之前,**不要把这两类图当作当前视觉真相**——包括未来任何一次审查。暗色模式目前零基准图。

### 3.7 性能:首屏下载了 41% 用不上的 JS

```
app/dist 总计        1,008,430 B raw  /  272,465 KB gzip
  vendor-recharts      422,483 B raw  /  112,111 B gzip  ← 占 gzip 总量 41%
  vendor-react         165,561 B raw
  index                325,808 B raw
```

12 个界面里只有 3 个画图表。根因在 `App.tsx:21-24`:

```tsx
const featureRouteModules = import.meta.glob<{ routes: RouteObject[] }>(
  './features/*/routes.tsx',
  { eager: true },        // ← 全部 10 个 feature 同步进主图
);
```

`vite.config.ts:38-45` 的 `manualChunks` 把 recharts 切进了独立文件——但 `manualChunks` 只切分**不延迟**。因为 glob 是 eager 的,`Dashboard` 及其 recharts 依赖进入了首屏图,浏览器必须在应用外壳首绘前下载并解析这 112 KB gzip。全仓库零 `React.lazy`、零 `Suspense`、零加载边界。

**修法**:去掉 `eager: true`,用 `React.lazy` 逐条包装,在 `FeatureRoutes`(`App.tsx:30-32`)外套一个 `<Suspense>`。`manualChunks` 保留——它本身是对的。对 9 个无图表路由,首屏 gzip 预计能砍掉约 40%。

### 3.8 缺少领域原语:18 个通用组件,0 个业务组件

`components/ui/` 的 18 个文件全是标准件。没有 `Amount`、没有 `MoneyDelta`、没有 `AccountChip`。后果是「一个金额长什么样」在 10 个界面里各写一遍:

- `formatMoney` 在 `dashboard/format.ts:8-16` 和 `accounts/format.ts:58-66` **逐字相同**地存在两份,加上 budget/goals/reports/transactions 各一份。
- 两个 `balanceToneClass` **已经开始互相矛盾**:`dashboard/format.ts:46-48` 对零值返回 `text-income`,`accounts/format.ts:11-15` 返回 muted。
- 8 色分类图表调色板被复制到 `Dashboard.tsx:108-117`、`TransactionStatsView.tsx:39-46`、`ReportDetail.tsx:96+`、`TagsSection.tsx:26`、`CategoriesSection.tsx:367` 五处。

`brand` 令牌被用了 73 次,但**从不用作主操作面**(`Button.tsx:16-17` 的 `variant="primary"` 是 `bg-text`,近黑)。这个应用命名了自己的品牌色,然后拒绝给任何东西打上品牌。

---

## 4. 动效路线图(按性价比排序)

D 代理给出了一份可执行计划集。要点如下。

**先决条件**:Plan 001(令牌 + 降级基线)必须先落地,其余计划都消费它的令牌。

| 序 | 改动 | 文件 | 规模 |
|---|---|---|---|
| 001 | 建 `--dur-press/surface/overlay/data/chart` 与 `--ease-out/in-out/drawer` 令牌;对 `animate-pulse`/`animate-bounce` 加 `prefers-reduced-motion` 降级 | `index.css` | ~25 行 |
| 002 | Modal 进场/退场(需要延迟卸载,`if (!open) return null` 让退场在结构上不可能) | `Modal.tsx` + `index.css` | ~35 行 |
| 003 | 全部 recharts series 统一 `animationDuration={600}` + `animationEasing="ease-out"`,降级时 `isAnimationActive={false}` | 4 个图表文件 + 新 hook | 属性扫描 |
| 004 | 按下反馈 `motion-safe:active:scale-[0.97]` | `Button.tsx` | **1 行** |
| 005 | `ProgressBar` 改 `transform: scaleX()` + `origin-left` | `ProgressBar.tsx` | ~6 行 |

**004 是整份动效审计里投入产出比最高的一条**:全仓库 `active:` 出现 0 次(唯一的命中是 `SettingsLayout.tsx:12` 的一个 TS 字段名),而 `Button.tsx:47` 的 transition 属性列表里**已经声明了 `transform`,却没有任何东西改它**。加一个工具类,全应用每一次「保存」「删除」「记一笔」都有了触觉确认。

**令牌建议**:入场/退场一律 `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`;`--dur-overlay: 220ms` 统一 modal / 下拉 / 抽屉 / toast;`--dur-chart: 600ms`。**禁用 `ease-in`**,本项目现在没有,以后也不要引入。

**「等待中」词汇表**(解决三套并存语义):等待超过约 1 秒 → `Spinner`(`animate-spin`);`animate-pulse` 只用于骨架屏;**`animate-bounce` 退役**。

### 明确不要做的

这几条看起来像缺口,补上会让产品更糟:

1. **不要给命令面板加动画。** `CommandPaletteView.tsx:139` 的 `if (!open) return null` 是**对的**。⌘K 是每天按 100 次的控件,Raycast 也没有进场动画。
2. **不要加 FLIP / 列表重排动画。** 本项目根本没有拖拽排序(grep `draggable`/`onDragStart`/`sortable` = 0 命中)。唯一存在的重排是切换日/周/月/年分组时的隐式重排,每天发生几十次。
3. **不要引入 `framer-motion` / `motion` / `gsap`。** 上面 5 个计划全部可以用 CSS 自定义属性 + Tailwind 3.4 core 的任意值 + `useSyncExternalStore` 达成,为一个本地优先、明确以最小依赖为设计价值的项目引入 40kB+ 运行时去表达 8 条声明式过渡,不成比例。
4. **不要加 View Transitions。** React 18 没有集成,`document.startViewTransition` 只有 Chromium 支持;而且 `AppLayout.tsx:168` 只有一个 `<Outlet />`,整屏交叉淡入会让两个无关数据面(含一个画到一半的 recharts 图表)重影。
5. **不要给 toast / 开关用 `@keyframes`。** 它们会堆叠、会被快速打断,keyframes 每次从头开始。用 transition + 挂载态属性。
6. **不要加 `transition: all !important` 这种全局降级开关。** 它会连带干掉 `animate-spin` 的例外、所有焦点过渡和 `useAnimatedNumber` 的 count-up。
7. **不要加 hover 阴影。** `accept/scripts/design-consistency.mjs:181,185` 是一条活的回归闸,断言 `hover:shadow-md` 计数为 0。这是已定的项目决策,hover 反馈一律用边框/背景色。
8. **不要改 `useAnimatedNumber` 的架构。** 它是全仓库最好的动效,扩展它,不要替换它。

---

## 5. 做得好的地方(应当保持并复制)

1. **`tailwind.config.js:17-21` 的暗色边框推导**。四行注释,公布实测比值(3.35:1 / 3.09:1)、说明约束在哪(较亮的卡片底才是紧约束)、保留色相的理由(H222°/S12.3%)。这是全仓库最好的单个产物,也是令牌文件其余部分本该效仿的模板。
2. **`Select.tsx` 全文(378 行)**。完整 ARIA combobox/listbox 语义、↑↓ Home/End/Enter/Esc/Tab 全键盘支持、`useId` 生成 id、翻转定位的 layout effect、键盘导航时的 scroll-into-view、Esc 与提交后的焦点归还,外加一段解释「为什么手写」的头部注释。**把它当成本项目所有基础组件的参考实现。**
3. **`SegmentedControl` 是有据可查的 Tabs 分叉**。`:4-10` 写明触发它的确切暗色故障(`pill` 选中态与容器同色,选中态不可见)。带理由的组件拆分才是成熟的设计系统。
4. **`useApi.ts` 的 SWR 契约**(`:9-23`)。把 `loading` 定义为「当前 url 没东西可显示」而不是「请求在飞」;后台刷新失败时保留陈旧数据而不是翻成错误页;暴露 `__resetApiCache()` 作为测试接缝。注释解释的是**决策**,不是语法。
5. **`app/index.html:8-29` 的首屏前主题引导**。内联、`try` 包裹、在首次绘制前解析 `dark`/`light`/`system`,缺失或损坏时正确回落到 `prefers-color-scheme`;配合 `store/theme.tsx:28-36` 实时订阅 `matchMedia` 的 `change` 事件。**主题切换零缺陷**,包括多数实现都会写错的「跟随系统」分支。
6. **`EmptyState.tsx:22-97` 的手绘 SVG**。`fill="none"` + `currentColor` + `aria-hidden="true"` + 显式 `width`/`height`/`viewBox`。免费换肤,不是素材图,而且是账本——它画的就是账本。用分层 `opacity` 做出纵深,一个硬编码颜色都没有。
7. **`SecuritySection.tsx:235-243` 的清库确认**。用平实语言讲清会毁掉什么、什么会保留(「分类与默认空间(id=1)会保留」),把「导出全部为 JSON」紧挨着放在上面,并要求键入「清空数据」字样才激活确认按钮。**这是全应用危险操作的标准线。**(但请注意:该面板和确认按钮现在都是绿色的,见 §3.2。)
8. **`ProfileSection.tsx:116` 的诚实占位**。「本地复刻版不会上传邮箱;此字段仅为 UI 兼容占位」——把占位讲得明明白白。问题在于同一件事在 `menu.tsx:105-106`、`Dashboard.tsx:895`、`reports/metadata.ts:44` 上没做到。
9. **`Dashboard.tsx:641-659` 的口径对账注记**。明确打印「另有 ¥X 的账户余额为负,未计入上方占比」「负债账户合计 ¥Y,不计入资产分布」——饼图百分比肉眼可核对,这直接消灭了一整类「数字看起来不对」的反馈。
10. **所有可比较的数字都上了 `tabular-nums`**。`AccountList.tsx:193,261`、`TransactionListView.tsx:293,341,461`、`ProgressBar.tsx:42`、`Dashboard.tsx:816,869,1149`、`MonthPicker.tsx:122`、`TransactionFormModal.tsx:562`。余额列因此是「扫读」的而不是「抖动」的。
11. **加载文案带了正确的省略号**:`保存中…` · `创建中…` · `更新中…` · `搜索或输入指令…`。纯文字,不闪 spinner,不带布局位移。
12. **零 `will-change`**。没有过度声明,也没有留在静止态上。默认就该这样。
13. **`tsc --noEmit` 在 `strict` + `noUnusedLocals` + `noUnusedParameters` 下干净通过**(实测 exit 0)。8 个运行时依赖。112 个源文件,21,629 行。

---

## 6. 本次审查修正了审查者自己的三个错误前提

诚实记录,以免后续审查重复:

| 最初假设 | 结论 | 谁纠正的 |
|---|---|---|
| 「全项目零 `prefers-reduced-motion`」 | **错**。`useAnimatedNumber.ts:17-25` 有实现正确的守卫,还处理了中断 | D · B |
| 「动效只有 Tailwind `transition` 工具类」 | **错**。recharts 提供了第二层不可见的动效,且 12 条 series 中只有 1 条配了 | D |
| 「基准图可用于视觉评审」 | **错**。3 条独立证据显示属于上一代设计 | A · B · D |

另外一个工具层面的结论:**检测器 1 条命中 ≠ 代码健康**。61 条规则在 21,682 行上只抓到一个 `animate-bounce`,而本报告的 P0 和四个 P1 它一个都没发现。它是个好 lint,不是审计。

---

## 7. 建议的修复顺序

按投入产出比排序,不是按严重度排序:

**第一批(一天内,改动极小,收益最大)**

1. `TransactionListView.tsx:473` 悬停专属的删除操作 → 补 `md:group-focus-within` + 移动端常显 + `aria-label`。
2. `AppLayout.tsx:285,163` 导航激活态的段前缀匹配(§3.1)。
3. `Button.tsx` 加 `motion-safe:active:scale-[0.97]`(1 行,全应用触觉反馈)。
4. `index.css` 加 `prefers-reduced-motion` 块,只覆盖 `animate-pulse` / `animate-bounce`。
5. `index.css` 建动效令牌。

**第二批(基础组件层,一处修好多处)**

6. `Modal.tsx` 补对话框语义 + 焦点陷阱 + 焦点归还(28 个调用点)。
7. `Switch.tsx` 暗色开启态换 `dark:bg-text-dark`,加 `aria-label` prop(5 处调用)。
8. 统一 `Field`(4 份 → 1 份,顺手删掉三份重复注释)。
9. `PageHeader` 加 `titleLevel` 默认 `h1`,修 `SettingsPage.tsx` 的层级倒置。

**第三批(色彩系统,需要测量与推导)**

10. 拆出 `--danger` / `--success` 语义轴,把 UI 状态从 `income`/`expense` 上摘下来。
11. 修 `text-expense` 2.54:1、`text-income` 3.76:1、亮色 `border` 1.19:1。**按 `tailwind.config.js:17-21` 的标准把推导过程写进注释**——既然暗色那半已经立了标准,亮色那半按同一标准补上。
12. 加 `brand.dark` 令牌,消灭 12 处 `dark:text-[#a5b4fc]`。

**第四批(结构性)**

13. `App.tsx` 去掉 `eager: true` 上 `React.lazy`,首屏 gzip 预计 -40%。
14. 删死代码 `layout/CommandPalette.tsx`;`PIE_COLORS`/`Field`/`DeleteConfirmModal` 各收敛成一份(净删约 300 行)。
15. 新增 `<Amount>` / `<Delta>` / `<AccountChip>` 三个领域原语,让 10 个界面各自重写的「金额语义」收敛到一处。

**第五批(验证基建)**

16. 引入 `@testing-library/react` + `jest-axe`,先落三个冒烟测试(看板 axe 干净、打开的 Modal axe 干净、Switch 必须有可访问名)。**这一步把本报告里的复发项变成 CI 失败**——目前 11 个测试文件 1,740 行全部覆盖计算逻辑,UI 层 21,682 行零覆盖,这就是这些缺陷能存活的原因。
17. 重新生成或明确标注 `docs/exploration-originals/` 的基准图。

---

## 8. 修复后重新验收

改完以后,这几条命令应当作为验收闸:

```bash
cd app && npm run build          # tsc -b && vite build 必须通过
cd app && npm run test           # vitest run 必须通过
node accept/scripts/design-consistency.mjs   # 108 条断言,同时守住"无 hover 阴影"这条已定决策
node accept/scripts/no-empty-flash.mjs       # 骨架屏/空状态闪烁回归
node accept/scripts/darkmode-audit.mjs       # 对比度(新增浮层与焦点环后必查)
~/.agents/skills/impeccable/scripts/impeccable detect --json app/src
```

最后一条注意读法:**exit 0 = 无命中,exit 2 = 有命中**。修完应当从 1 条降到 0 条。但如 §6 所述,这一条干净**不等于**通过验收——要配合 §7 第五批的 axe 测试。

---

*本报告由 4 个隔离子代理 + 主会话独立取证综合而成,非任何单一工具的输出。*
*所有 `file:line` 引用均来自 `24422a4`。标「需真机验证」的条目尚未在浏览器或设备上确认。*
