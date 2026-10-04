# MiniMax 任务队列进度（跨会话续跑）

> 用法：M3.1 小时级额度耗尽时停在这里；额度恢复后从"下一个任务"继续派 minimax 挨个做。
> 每个任务完成：调度方亲自验收（tsc/vitest/build/相关 accept 脚本）→ commit → 勾掉 → 继续下一个。

## 队列来源
- design-review.md 修正批次的遗留（2026-10-05）
- 各批次 agent 交接时发现但未授权处理的事项

## 已完成（2026-10-05 第一批，额度耗尽前完成 2 个）
- [x] **T1 ISSUE-005 calcNetAsset 信用账户符号翻转**（bcb3a54）
      三处副本全修 + 14 例新单测 + Dashboard 负债标签签名化
- [x] **T2 ISSUE-006 分类色暗色对比度**（bcb3a54）
      分类名中性文字+彩色圆点，darkmode-audit 3 issue 消除，14.06:1

## 下一个任务（按此顺序继续）

### T3 a11y 尾巴：裸 label + Select 读屏取名
- 背景：Field×5 已收敛，但 features/ 下仍有 ~15 处手写裸 `<label>`（无 htmlFor）；
  Select.tsx 是自写 role=combobox 按钮，读屏取不到名字
- 修法：裸 label 换用 components/ui/Field 或补 htmlFor+id；Select 加 aria-label/aria-labelledby prop（Field 集成自动传）
- 授权：app/src/features/ 相关文件、components/ui/{Select,Field}.tsx、app/tests/
- 验收：裸 label 残留 0；Select ≥3 处调用有可访问名；app vitest 全过（当前基线 223）

### T4 app 侧 csv.ts 漏 1 行
- 背景：支付宝 1 笔（¥39.35 花呗·班尼路·2026-05-17，订单号字段带尾随 Tab）被判解析失败丢弃
- 修法：定位 split 后未 trim 的根因，修 parser，构造样本回归
- 授权：app/src/features/transactions/csv.ts、app/tests/csv*.test.ts

### T5 darkmode-audit「保存/下一步/确认」5 条告警定性
- 背景：改动前后 selector 一致，疑似误报但需实测
- 要求：读审计脚本判定逻辑 → Playwright 取按钮真实 computed color 算对比度 →
  达标则脚本加豁免注释（写实测值）；不达标则修按钮样式
- 授权：accept/scripts/darkmode-audit.mjs、（若真问题）对应按钮源文件

### T6 过期基准图标注
- 背景：docs/exploration-originals/*.png 拍于 2026-08-20，早当前代码 6 周，暗色零基准
- 要求：写 README.md：拍摄日期、对应哪代设计（对照点）、勿当视觉真相警示、暗色无基准说明
- 授权：docs/exploration-originals/README.md（新建）

## 暂缓项（需用户决策，不派 agent）
- 账户期初余额校准（等用户抄 7 个真实余额）
- 内蒙古农信卡(6322) 是否独立建户（2 笔还款现落现金→花呗兜底）
- @testing-library+jest-axe 基建、`<Amount>` 领域原语（YAGNI 搁置）
- 目标类型色轴（储蓄红/还款绿）、超支红报警（有注释的既有约定）——用户约定内自洽，不动

## 已知 flake（非缺陷，别修）
- core tests/bill.test.ts「错误密码时自建的临时目录会被清掉」：
  数 OS tmpdir 目录数，与并行 CLI 子进程干扰，单独跑必过、全量偶发 1/256 概率红
