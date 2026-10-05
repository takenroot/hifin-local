# 已知问题记录

## ISSUE-001：微信账单 URL 提取曾拿到不完整 URL（4字节假文件）

**发现时间**：2026-10-02
**状态**：已修复，根因待复盘

### 现象
poller 首次自动下载微信账单 ZIP 时，解压后只有一个 4 字节的 `alipay_record.csv`（内容为 `a,b`），而非真实的 53KB 微信账单 xlsx。

### 用户验证
用户手动复制邮件中的完整 URL 到未登录浏览器，成功下载 53KB 真实 ZIP。说明 **URL 本身无需登录态，问题在提取或下载环节**。

### 根因分析（推测）
1. **HTML 实体未完全解码**：微信邮件 HTML 中的 `&amp;` 在提取时可能未被还原为 `&`，导致 URL 参数截断
2. **MIME base64 解码缺失**：poller 最初直接把原始 MIME 字符串传给 extractor，未做 base64 解码，extractor 在乱码中匹配 `<a>` 标签失败
3. **下载响应未校验**：下载器未检查 Content-Type / Content-Length，把错误响应当成 ZIP

### 已实施的修复
- `extractHtmlPartFromMime`：从 MIME 多部分中提取 text/html part 并 base64 解码
- `xlsxToCsvText`：微信账单是 .xlsx 不是 CSV，新增 Excel → CSV 转换
- 下载后校验 ZIP 魔数（`PK\x03\x04`）

### 待验证
- [ ] 用真实微信邮件完整回归测试（重新申请账单 → mail poll 全自动）
- [ ] 在 extractor 中加 URL 完整性校验（检查 `encrypted_file_data` 参数是否以 `AB` 开头）
- [ ] 下载响应 Content-Type 必须是 `application/zip` 或 `application/octet-stream`

---

## ISSUE-002：Tailwind 配置更改后 vite dev server 需重启才生效

**发现时间**：2026-10-02
**状态**：已解决（操作问题）

### 现象
修改 `tailwind.config.js` 交换 income/expense 颜色后，前端仍显示旧颜色。

### 根因
Tailwind CSS 在 vite dev 模式下会缓存生成的 CSS。`tailwind.config.js` 更改后**必须重启 vite dev server**，否则继续用旧配置生成的 CSS。

### 教训
- 改 Tailwind 配置 → `pkill -f "vite.*端口"` → 重启
- 或在文档中标注"配置更改后需重启 dev server"

---

## ISSUE-003：ZipCrypto 错误密码有概率被误判为 BillFormatError（测试/分类偶发）

**发现时间**：2026-10-02（core `tests/bill.test.ts` 偶发失败暴露）
**状态**：已修复

### 现象
`unzipBill` 用错误密码解压时，期望抛 `BillPasswordError`，偶发抛
`BillFormatError: ZIP 解压失败: invalid block type`。

### 根因
ZipCrypto 的密码校验只靠 1 字节 verification byte，错误密码有约 1/256
概率恰好通过校验，随后解密出乱码，zlib 报 `invalid block type`，
被错误归类为"格式错误"而非"密码错误"。

### 影响
- 用户侧：通知系统对"密码错误"与"格式错误"的提示文案不同，偶发会误导
- 测试侧：`tests/bill.test.ts > unzipBill > 错误密码抛 BillPasswordError` 约 1/256 概率 flake

### 修复方式
`core/src/bill/unzip.ts` 解压 catch 分支：保留原有的 "Wrong Password" 识别，
其后按"调用方确实给了密码"这一前提，补两类误判的兜底。**没给密码时，
格式错误仍然归 `BillFormatError`。**

1. **zlib 解压类错误**。优先看错误对象的 `code`——`Z_DATA_ERROR` / `Z_BUF_ERROR`
   等 `Z_*` 前缀是 zlib 独占的命名空间，adm-zip 自己的错误不带，比对文案更硬，
   也扛得住 zlib 换文案（0.6 的同步解压直接抛 zlib 原生 error，不包装，已实测）。
   `code` 丢失时才退回比对 `ZLIB_INFLATE_ERRORS` 文案表。

   > 文案表是拿本机 zlib 随机灌了几十万条乱码实测出来的，加上 inflate.c 全集。
   > 开发这个 ISSUE 时手写漏过 `invalid literal/length code`，测试第 5 轮才炸出来
   > ——落点纯看运气，漏一条就等于又留了一次偶发误判。

2. **CRC 校验不符**。蒙混过关的乱码有小概率（实测约 0.5%）恰好拼出一棵"合法"的
   deflate 树，zlib 不报错、改由 CRC 拦下。密码正确时 CRC 必然对得上，所以对
   **加密条目**而言，调用方给了密码却 CRC 不符，同样只可能是密码不对。
   这一层特意加了 `hasEncryptedEntries` 门禁：未加密的包 CRC 对不上是文件真损坏，
   必须照旧报格式错误。

### 测试加固
`core/tests/bill.test.ts` 新增两个用例：
- **20 个不同错误密码全部抛 `BillPasswordError`**，且断言没有一个是
  `BillFormatError`。密码名单在运行时现挑——ZipCrypto 的 salt 每次加密随机生成，
  写死名单只会得到一个碰运气、甚至悄悄失效的用例；挑不满 20 个则当场判红，
  防止用例悄悄退化成只测普通错误密码。
- **未加密的 ZIP 内容损坏时仍归 `BillFormatError`**，锁住上面第 2 条的门禁边界。

对照实测：修复前 65/65 个蒙混通过的错误密码**全部**被误判成 `BillFormatError`；
修复后 0/81 误判。另单独构造 6 个走 CRC 分支的错误密码，均正确归为
`BillPasswordError`。

---

## ISSUE-004：规则引擎的两个已知限制（低危，不影响存量数据）

**发现时间**：2026-10-03（226 条自动生成规则落库后的回放评估暴露）
**状态**：已知限制，暂不修

### 1. 同优先级规则无 tiebreak

`makeRuleMatcher` 按 `priority DESC` 取第一条命中；226 条自动生成规则 priority 全是 10，
同优先级胜出者实际取决于 SQLite 返回顺序（回放脚本用 `createdAt ASC` 兜底，但
importer 的 ORDER BY 没有显式 tiebreak）。**影响**：未来若两个同优先级规则都能命中
同一商户，分类结果理论上不稳定。目前 226 条规则的 keyword 互不包含（除已禁用的
单字符规则），未观察到实际冲突。

### 2. REST 规则写入无长度校验

`POST/PUT /api/rules` 不校验 keyword 长度。单字符 keyword（如"平"）在 includes
语义下会误伤（曾命中"拼多多平台商户"）。生成路径 `apply-merchant-rules.ts` 已有
硬自检，存量单字符规则已 `enabled=0`；但手工从 UI/API 加规则时没有拦截。
**缓解**：设置→规则页可见可改，用户自查。

---

## ISSUE-005：`calcNetAsset` 对正余额信用账户符号翻转（低危，待校准后顺手修）

**发现时间**：2026-10-03（多账户拆分首次建花呗账户暴露）
**状态**：已知，待修

### 现象
`core/src/routes/summary.ts` 与 `app/.../calculations.ts` 的 `calcNetAsset` 对
credit/debt 账户一律 `debt += Math.abs(balance)`。花呗当前推算余额为 **+139.29**
（账单花呗支出 8,093.87 < 还款 8,233.16，即多还了/退款在途），被当成
"负债 139.29"而非"资产 -139.29"，导致看板净资产 -28,515.67 与
Σ账户余额 -28,237.09 差 278.58。

### 影响
- 只要信用账户余额为正（多还/退款在途），净资产就偏差 2×该金额
- 用户校准花呗为真实欠款（负值）后当前数据自愈，但代码缺陷仍在

### 修法（待做）
`debt += -a.balance`（负余额 → 正负债；正余额 → 负负债即资产）。
改时需同步两侧 + 看板"资产分布"卡的负债口径 + 回归脚本。

---

## 待办事项（非缺陷）

- [ ] **账户期初余额校准**：7 账户余额均为流水推算值（工行卡 -36,089 等明显失真）。
  需用户从微信/支付宝/银行 App 抄真实余额，生成"余额校准"调整行后净资产即真实化
- [ ] **余额宝/零钱通收益手工记账**：无 API 可同步，每年底（或一月催填通知提醒时）
  在账户表单记一笔年度收益
- [ ] **内蒙古农信储蓄卡(6322)**：2 笔花呗还款（¥1,042.13）因该卡不在 7 账户设计内，
  按兜底口径记为「现金 → 花呗」；如需独立账户要改 account-map + 补建账户
- [ ] **app 侧 csv.ts 漏 1 行**：支付宝账单中 1 笔（¥39.35 花呗·班尼路·2026-05-17，
  订单号字段带尾随 Tab）被判解析失败丢弃，core 管道不受影响；修复需授权 app/src/features/transactions/csv.ts

---

## ISSUE-006：分类图标色暗色模式对比度不足 2.5~2.9:1（存量，低危）

**发现时间**：2026-10-05（design-review 修正批次的 darkmode-audit 因布局位移重新暴露）
**状态**：已知，待设计决策

### 现象
交易行/统计页的分类名直接使用分类自带的图标色（如「数码电器」紫 #7e22ce 2.49:1、
「停车费」蓝 #1d4ed8 2.6:1、「加油」天蓝 #0369a1 2.93:1，暗色卡片底 #171a21 上）。
34 个分类色是种子数据，暗色下普遍低于 AA 4.5。

### 候选修法（需决策）
- 暗色模式下分类色整体提亮一档（分类色表加 dark 变体）
- 或分类名文字改中性色，颜色只留小圆点/图标（信息不丢、对比度全交给文字）

### 另注
darkmode-audit 的「保存/下一步/确认」5 条按钮文本告警已定性（T5）：**确认误报**。
不是 secondary 按钮的问题，而是 primary 按钮的**禁用态**：实测启用态 4.47:1，
禁用态按 `disabled:opacity-40` 合成观感后 1.94:1。WCAG 1.4.3/1.4.11 明确豁免
inactive user interface component，已在 `darkmode-audit.mjs` 的 `classifyTextRecord`
处降级为 advisory（实测值与推理见该函数上方注释）。issue 总数 11 → 6，未新增。
