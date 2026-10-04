# ISSUE-006 验收证据：分类 chip 改中性文字 + 分类色圆点

改动：`app/src/features/transactions/TransactionListView.tsx`（TxRow 元信息行）
回归测试：`app/tests/tx-category-color.test.ts`

## 明暗对比

| 口径 | 改前 | 改后 |
| --- | --- | --- |
| 分类名文字（暗色 #171a21 卡片底） | 2.49 / 2.60 / 2.93:1（数码电器 #7e22ce、停车费 #1d4ed8、加油 #0369a1） | **14.06:1**（#e5e7eb，全量 808 个 chip 取最低值） |
| 分类名文字（亮色 #ffffff 卡片底） | 随分类色浮动 | **17.74:1**（#111827） |
| 分类色载体 | 文字本身 | 8×8 圆点（border-radius 9999px），图形 1.4.11 达标即可 |

圆点尺寸由 Playwright 量得：`8x8 9999px`，808 个 chip 全部一致。

## darkmode-audit（127.0.0.1:5185 起自建 vite，9 页 + 9 Modal）

- `baseline-issues.json` = 改前，`after-issues.json` = 改后（同一脚本、同一数据集）
- issue 总数 **14 → 11**；消失 3 条全部是分类色：数码电器 2.49 / 停车费 2.60 / 加油 2.93
- **新增 issue = 0**；新增 advisory = 0
- advisory **137 → 128**，消失 9 条同样是分类色文字（服饰 / 咖啡奶茶 / 美妆护肤 / 旅行 / 游戏 / 保险 / 打车 / 日用百货 / 其他支出）
- 改后 issues.json 中再也搜不到任何分类名文本

## 截图

| 文件 | 视口 | 内容 |
| --- | --- | --- |
| `transaction-dark-1440.png` | 1440×900 暗 | 流水列表，分类名中性色 + 前置圆点 |
| `transaction-light-1440.png` | 1440×900 亮 | 同上亮色 |
| `transaction-dark-390.png` | 390×900 暗 | 窄屏布局 |
| `transaction-light-390.png` | 390×900 亮 | 窄屏布局 |
| `stats-dark-1440.png` / `stats-light-1440.png` | 1440×900 | 统计分类排行（本来就已是中性文字 + 色块，本次未改，14.06:1 / 17.74:1） |

## 390px 布局核对

- `document.scrollWidth 390 / innerWidth 390`，**无横向溢出**
- 圆点右边界从未超出元信息行容器（`圆点被挤出容器=false`）
- 元信息行尾部截断属预期行为（该行本就 `overflow:truncate`），首项「圆点 + 分类名」始终完整可见
