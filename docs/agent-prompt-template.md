# 给后续 subagent 的 prompt 模板

主 agent 派任务时，把本模板的【环境盘点】【环境约束】【任务前置】【收尾要求】四段拼到具体任务说明前后。模板与具体任务解耦。

---

## 【环境盘点】（来自主 agent 已确认）

> subagent 不得假设工具已装，必须自己验证可用性。

- **运行时**：Node v24.19.0 / npm 12.1.0（在 PATH）
- **工作目录**：仓库根 `/home/saltedfish/project/hifin/`；应用代码在 `app/`；验收脚本在 `accept/scripts/`
- **Playwright**：v1.55.0，路径 `/home/saltedfish/project/hifin/node_modules/playwright`
- **浏览器 cache**：`~/.cache/ms-playwright/`
  - `chromium-1237` — DSH host 锁定的完整 Chromium（AGENT_BROWSER_EXECUTABLE_PATH 已设）
  - `chromium_headless_shell-1187` — 与 playwright@1.55.0 配套
  - `ffmpeg-1011` — 所有 playwright 视频录制共用
  - **绝对禁止** `npx playwright install` 或 `npx playwright install chromium`（会触发新下载，污染 cache）
- **预览服务**：vite 默认端口 5173；5199 是主 agent 的预览服务（**绝不可触碰**）；自查端口由任务具体指定，优先在 5185-5190 之间选（`npx vite --port <端口> --strictPort`）
- **数据**：SQLite 唯一数据源（core REST 服务 :8787），前端全走 REST `/api/*`，IndexedDB 已废弃；验收脚本通过 `http://127.0.0.1:<指定端口>/` 操作真实页面
- **网络**：npm registry 可用；外部 API —— Open-Meteo（天气）、IMAP（账单邮件轮询）、OpenAI 兼容端点（AI 助手，用户自行配置）

## 【环境约束】

1. **任务开始前 30 秒必做**：跑 `node -e "require('playwright')"` 验证 playwright 还在；跑 `ls /home/saltedfish/.cache/ms-playwright/` 确认浏览器就位；`cd app && npm run build` 验证构建基线
2. **工具缺失时立即停止**：如果任务需要的工具/依赖不可用（如某个 npm 包未装、某 CLI 不在 PATH、某 API 不可达），**不要自行安装/替代**——直接输出 `环境缺X，无法继续` 作为最终回复并停下，等待主 agent 协调
3. **禁止裸 `pkill -f vite`**：永远只 `pkill -f "vite.*<任务指定端口>"`；5199 是主 agent 的预览服务，被误杀算严重事故
4. **不要扩展任务范围**：仅修改任务授权的文件清单内文件

## 【任务前置】

1. **先 `read` 任务授权的所有相关文件**，确认当前状态
2. **若发现主要工作已完成**（如目标文件已含修复、根因已被某 commit 解决），**不要重复实施**——直接简述现状 + 跑一遍验证即结束
3. **不要"顺手优化"**：禁止动不在任务清单内的文件（即使觉得可以"顺便"修）
4. **如果看到 git dirty 改动**（`git status` 有非本次任务的 M 状态文件），**只读不改**

## 【任务】

> 下面填具体内容：
> - 范围（精确到文件路径）
> - 改动要求（描述意图 + 验收标准，不要给完整代码）
> - 自查端口
> - 验收脚本要写到 `accept/scripts/` 而不是临时目录

## 【收尾要求】

1. **必须输出纯文本总结**，包含：
   - 改动文件清单（绝对路径）
   - 任何"发现任务已无需执行"或"环境缺X"的状态说明
   - `npm run build` 与 `npx vitest run` 的执行结果（成功/失败）
   - Playwright 自证截图路径或断言结论
2. **若任务在过程中遇到任何工具/上下文缺失**：第一时间停止 + 报告，不要硬撑

---

## 主 agent 使用示例

派任务时把四段拼起来，示例：

```
【环境盘点】
<贴本文档完整模板>
【环境约束】
<贴本文档完整模板>
【任务前置】
<贴本文档完整模板>
【任务】
修复 X：仅修改 src/features/xxx/X.tsx
1. 行为 A
2. 行为 B
自查端口 5190，写 accept/scripts/fix-x.mjs 用 playwright 截图验证。
【收尾要求】
<贴本文档完整模板>
```

## 常见误区（已踩过的坑）

- ❌ 启动多个 dev server 占用多个端口（自查一次就够了）
- ❌ `npm install playwright` 重新下载（cache 已配好）
- ❌ `pkill -f vite` 误杀 5199
- ❌ 把修复写成完整源代码（应描述意图 + 验收标准，subagent 自己写）
- ❌ 跨文件"顺手优化"（极易冲突）
- ❌ 跳过 `git status` 检查，盲目相信 HEAD
- ❌ 把账单解压密码写进任何文件（脚本默认值、注释、硬编码）——一次性密码只许命令行参数/环境变量传入（安全规约，真实踩过：默认值进了回填脚本被调度方打回）
- ❌ 测试基线造假：当前基线 core 265 例 / app 105 例全过，开工先跑一遍，结束时必须仍全过
- ❌ 批量改数据后不复核不变量：`accounts.balance == Σ(income) - Σ(expense)`（excluded/transfer 不计）必须前后一致
- ❌ 验收脚本 mock 只盖一半：`page.route` 里 `route.fallback()` 会把没显式处理的写请求（POST/PUT/DELETE）打进真实 :8787 污染用户数据库——凡触发写操作的用例，所有写路径都必须显式 fulfill（真实踩过：账户创建 fallback 产生 10 个垃圾账户）
- ❌ 把第三方运行时类名（如 `.recharts-wrapper`）的 CSS 规则写进 Tailwind `@layer`：JIT tree-shake 会剥离未出现在源文件中的类，规则静默丢失——这类规则必须写在 @layer 外
- ⚠️ 测试基线会过期：以调度方当次 prompt 为准（本文档的 265/105 已是旧值），开工先跑 `npx vitest run` 实测