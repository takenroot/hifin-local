/**
 * 账户模块内部格式化辅助函数
 *
 * formatMoney / balanceToneClass 已收敛到 @/lib/format，这里仅 re-export
 * 以保持既有 import 路径不变；模块特有的辅助函数仍留在本文件。
 */
export { formatMoney, balanceToneClass } from '@/lib/format';
import { formatMoney, balanceToneClass } from '@/lib/format';

/** 负债类账户（花呗 / 白条 / 房贷…）在账户类型里的取值 */
export function isDebtType(type: string): boolean {
  return type === 'credit' || type === 'debt';
}

/**
 * 负债账户的余额配色：**恒为红**，不看正负。
 *
 * 为什么不给它套用 balanceToneClass
 * -----------------------------------------------------------------
 * 全局约定是"红=有钱、绿=欠钱"，这在资产账户上是对的：正就是有钱。
 * 但负债账户上就反直觉了——花呗还清之后余额是正的（可用额度），按约定会
 * 显示成红色"有钱"，而它明明躺在"负债"分组里；欠钱时反而是绿色。
 * 用户扫一眼列表根本判断不出哪个是欠的。
 *
 * 所以负债账户统一用红色 + 绝对值展示，语义只由"它在负债分组里"决定：
 * 红色 = 这是笔要还的钱。资产账户仍按正负着色，行为不变。
 */
export function debtBalanceToneClass(): string {
  return 'text-income';
}

/**
 * 账户卡片上余额的展示口径：数字 + 配色类。
 *
 * 负债账户取绝对值（欠 300 显示 300，不显示 -300）并强制红色；
 * 资产账户原样显示并按正负着色。
 */
export function accountBalanceDisplay(
  balance: number,
  type: string,
): { text: string; toneClass: string; isDebt: boolean } {
  const debt = isDebtType(type);
  return {
    text: formatMoney(debt ? Math.abs(balance) : balance),
    toneClass: debt ? debtBalanceToneClass() : balanceToneClass(balance),
    isDebt: debt,
  };
}

/** 解析用户输入金额：允许空 / 自动去空格 / 不合法则返回 0 */
export function parseAmount(input: string): number {
  if (!input) return 0;
  const cleaned = input.replace(/[, ]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}
