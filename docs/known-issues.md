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
