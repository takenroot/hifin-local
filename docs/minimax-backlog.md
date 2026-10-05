# MiniMax 任务队列进度（跨会话续跑）

> 用法：M3.1 小时级额度耗尽时停在这里；额度恢复后从"下一个任务"继续派 minimax 挨个做。
> 每个任务完成：调度方亲自验收（tsc/vitest/build/相关 accept 脚本）→ commit → 勾掉 → 继续下一个。

## 队列来源
- design-review.md 修正批次的遗留（2026-10-05）
- 各批次 agent 交接时发现但未授权处理的事项

## 已完成（2026-10-05 第一批 2 个 + 第二批 4 个，全部验收提交）
- [x] **T1 ISSUE-005 calcNetAsset 信用账户符号翻转**（bcb3a54）
      三处副本全修 + 14 例新单测 + Dashboard 负债标签签名化
- [x] **T2 ISSUE-006 分类色暗色对比度**（bcb3a54）
      分类名中性文字+彩色圆点，darkmode-audit 3 issue 消除，14.06:1
- [x] **T3 a11y 尾巴**（b584b55）前提过时未照做，改打 7 个真缺陷：无名 Input/group、
      星号混入 accname（Field required+aria-hidden 一处修全站），+9 例
- [x] **T4 csv 分隔符探测**（e09ebd8）根因比记载更深：,\t; 同时当分隔符致列错位，
      表头探测一次统一切；+4 例；发现 T7 新问题
- [x] **T5 审计误报定性**（428f3e4）5 条全为 disabled:opacity-40 按钮（1.94:1 观感色），
      WCAG 豁免 inactive 组件，降级 advisory 带实测值，issue 11→6
- [x] **T6 基准图标注**（5f6a3e6）README 四要素+scrim/暗色辨析；纠正 design-review 过期描述
- [x] **T7 app/CLI 导入路径 100% 丢光**（ec63a73）kimi 调查定性（GBK+前言剥离缺失）→
      minimax 实施（UTF-8 优先探测+共享 decodeBillBytes+假表头门槛，修正调查方案两处硬伤、
      揪出 CLI import-csv 兄弟 bug）→ 调度方补 CLI 尾+误导入回滚（教训：CLI 测试须用 DB 副本）
- [x] **T8 未转义逗号静默丢行**（5262c0f）改明确 warning 不入库错列；列数统计必须走同一
      引号感知切分器（朴素 split 会把真实微信 5 行规范引号逗号误判）；真实原件 0 warning；
      附带缓解 bill.test.ts tmpdir 计数 flake（vi.waitFor 窗口，6 连跑全过）

## 下一个任务（队列已清空——新任务从这里追加）

### ~~T7 app 导入路径读不进真实支付宝导出~~（已完成 ec63a73：kimi 调查 + minimax 实施 + 调度方补 CLI 尾）
- 背景：app 侧 TransactionImportView 只按 UTF-8 裸读，无前言剥离——带 22 行前言的
  真实支付宝导出走 app 路径 valid=0 整份丢光；core 在 importer.ts:288-295 有
  前言剥离+GBK 解码，但 core 与 app 共享的 csv parser 只管字段级解析
- 修法：把前言剥离+编码探测下沉到 app 导入路径（或共享预处理函数）；注意全平台
  表头探测语义对齐 core
- 授权：app/src/features/transactions/（TransactionImportView/csv.ts）、app/tests/、
  必要时 core/src/bill/importer.ts（保持两边语义一致）
- 验收：真实支付宝导出文件（GBK+前言）走 app 路径能解析出全部行；core 399/app 240+ 全过

### ~~T8 未转义逗号丢行~~（已完成 5262c0f：静默丢行→明确 warning，YAGNI 不做 RFC 4180）
- 背景：逗号 CSV 字段内含裸 , 同样错位丢行；廉价修不了，csv.ts 注释已写明
- 候选：引号感知切分（RFC 4180 -lite）或明确报错"该文件含未转义逗号"而非静默丢行
- 倾向后者（YAGNI：真实账单都由 core 管道导入，app 路径是手工补充）

## 暂缓项（需用户决策，不派 agent）
- ~~账户期初余额校准（等用户抄 7 个真实余额）~~ **用户已完成（2026-10-05，自行调整账户）**
- ~~内蒙古农信卡(6322) 是否独立建户~~ **用户决策：6322 不计入项目，维持现金→花呗兜底**
- ~~Tauri 桌面 App~~ **用户决策：不做（2026-10-05）**
- @testing-library+jest-axe 基建、`<Amount>` 领域原语（YAGNI 搁置）
- 目标类型色轴（储蓄红/还款绿）、超支红报警（有注释的既有约定）——用户约定内自洽，不动
- ISSUE-001 真实微信邮件回归：用户今年年底前才重申请流水，届时再验（记于 known-issues）

## 已立项（2026-10-05 用户批准）→ 全部完成（2026-10-05 晚，两波 minimax 实现 + 调度方逐文件验收）
- ~~MCP server / AI 分析引擎 / SSE 实时通知调研~~ 调研产出 docs/mcp-design.md、
  docs/ai-insights-design.md、docs/sse-design.md（commit 2dac8ed，含调度方评审修正：
  v5 迁移 + dayjs 去除 + 接口计数/降级语义）
- 实现 Wave 1（并行不相交，commit f2016a5）：MCP server 11 工具 + SSE 通知；
  core 393→434 / app 278→288
- 实现 Wave 2（commit f4f2a71）：AI 洞察引擎（schema v5 + insights 四件套 + 5 端点 +
  前端 toast/角标）；core 434→492；调度方修 month=stored 日志残句
- 验收记录：tsc 两侧干净、vitest 全绿、vite build 过、v5 迁移对真实库 /tmp 副本回归
  （行数保留/新类型可写/垃圾类型被拒）、洞察 e2e 冒烟（无模型→规则版通知）通过
- 遗留观察：MCP 写工具并发多 host 共写无锁（UNIQUE 索引兜底重复导入，known 风险，不修）；
  SSE 跨进程事件不可达（CLI 触发的通知走不到 server 进程的 bus，轮询兜底覆盖，sse-design §4.8 表述已失真，事实如此）

## 事故档案：共享工作区 git 回滚（2026-10-05，已善后）
- B/T8 agent 均报告过"工作区被 stash 类操作整体回滚又恢复"——后果查实：
  b584b55（T3）丢了源码只进了测试（message 与内容不符），T5 的 known-issues
  更正也丢了。靠工作区 stash 恢复 + 本次补提交（1f16e75）已完全对齐，
  验证法：git show HEAD:<file> 与磁盘逐文件比对 + 全量测试
- 教训：agent 汇报"git 事故"时必须当场逐文件核对 commit 内容，不能信 message

## 已知 flake（已缓解，彻底修需改 unzipBill 签名——YAGNI 搁置）
- core tests/bill.test.ts「错误密码时自建的临时目录会被清掉」：
  数 OS tmpdir 目录数，与并行测试文件的临时目录竞争（历史 ~1/10）。
  已加 vi.waitFor 2s 窗口（5262c0f），6 连跑全过；持续高负载下仍可能超时，
  彻底隔离需给 unzipBill 加 tmpRoot 注入参数，改动源签名不值当
