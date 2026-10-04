/**
 * 类型与空间 hook 模块（数据访问走 REST /api/*）
 *
 * SQLite（core 服务）是唯一数据源，本模块不再实例化任何本地数据库；
 * 运行时只保留：
 *  - 各实体的 TypeScript 类型定义；
 *  - 默认空间常量 DEFAULT_SPACE_ID；
 *  - 读取当前空间的 hook useSpaceId。
 */

import { useAtomValue } from 'jotai';
import { spaceIdAtom } from '@/store/atoms';

// ─────────────────────────── 枚举 / 类型 ───────────────────────────

export type AccountType =
  | 'fund' // 资金（日常收入支出）
  | 'asset' // 资产（保值增值）
  | 'social' // 社保
  | 'invest' // 投资
  | 'other' // 其他资产
  | 'credit' // 信用（信用卡、花呗等）
  | 'debt'; // 债务（车贷、房贷等）

export type TransactionType = 'expense' | 'income' | 'transfer' | 'excluded';

export type GoalKind = 'saving' | 'repayment';

export type CategoryType = 'expense' | 'income';

// ─────────────────────────── 接口 ───────────────────────────

/** 多空间：默认空间 id = 1；id=0 在前端语义上是"全部空间"（不过滤）。 */
export interface Space {
  id?: number;
  name: string;
  createdAt: number;
}

export interface Account {
  id?: number;
  name: string;
  type: AccountType;
  balance: number;
  remark?: string;
  tagIds?: number[];
  includeInNetAsset: boolean;
  /** 所属空间 id；undefined 视为默认空间 1 */
  spaceId?: number;
  /**
   * 最近一次填写的年度收益金额（core: GET /api/accounts 随账户一起下发）。
   *
   * 例：{ year: 2025, annualIncome: 350 } = 2025 年实际赚了 350 元。
   * 记的是金额而不是年收益率：余额天天在变，"余额 × 收益率"推出来的预估数没有意义。
   *
   * 兼容说明：老版本 core 或接口失败时该字段整体缺失，
   * 因此这里是可选的，展示层一律按 null / undefined 容错。
   */
  latestYield?: { year: number; annualIncome: number } | null;
  createdAt: number;
  updatedAt: number;
}

export interface Transaction {
  id?: number;
  type: TransactionType;
  name: string;
  amount: number; // 正数
  date: number; // 时间戳
  categoryId?: number;
  accountId: number;
  toAccountId?: number; // 转账时的目标账户
  remark?: string;
  tagIds?: number[];
  merchantId?: number;
  includeInAsset: boolean;
  /** 所属空间 id；undefined 视为默认空间 1 */
  spaceId?: number;
  /** 来源平台：alipay / wechat / manual / csv */
  source?: string;
  /** 平台交易单号（与 source 组合唯一；手工录入无） */
  externalId?: string;
  /** 支付方式主渠道（零钱通/花呗/银行卡等），来自账单原件 */
  paymentMethod?: string;
  /** 交易状态原文（交易成功/已全额退款 等），来自账单原件 */
  status?: string;
  createdAt: number;
}

export interface Goal {
  id?: number;
  kind: GoalKind; // saving | repayment
  subtype?: string; // 买房 / 买车 / 应急基金 / 信用卡 / 房贷 等
  name: string;
  targetAmount: number;
  currentAmount: number;
  deadline?: number;
  accountId?: number;
  icon?: string;
  color?: string;
  /** 所属空间 id；undefined 视为默认空间 1 */
  spaceId?: number;
  createdAt: number;
}

export interface Category {
  id?: number;
  name: string;
  group: string; // 分组名：餐饮 / 交通 …
  type: CategoryType; // expense | income
  icon?: string;
  color?: string;
}

export interface Tag {
  id?: number;
  name: string;
  color?: string;
}

export interface Merchant {
  id?: number;
  name: string;
  remark?: string;
}

export interface Report {
  id?: number;
  name: string;
  description?: string;
  template?: string;
  icon?: string;
  /** 自定义配置（JSON 字符串）。存在时 ReportDetail 按配置渲染，否则按 template 走老模板逻辑（向后兼容）。 */
  config?: string;
  createdAt: number;
}

/** 预算周期 */
export type BudgetPeriod = 'monthly' | 'yearly';

export interface Budget {
  id?: number;
  name: string;
  /** 关联分类 id；undefined 表示"总预算"（覆盖全部支出） */
  categoryId?: number;
  amount: number;
  period: BudgetPeriod;
  /** 所属空间 id；undefined 视为默认空间 1 */
  spaceId?: number;
  createdAt: number;
}

export interface AiModel {
  id?: number;
  name: string;
  model: string;
  endpoint: string;
  apiKey?: string;
}

/** 规则匹配字段：name 流水名称 / merchant 商户（导入时对应 ParsedTx.merchant）/ remark 备注 */
export type RuleMatchField = 'name' | 'merchant' | 'remark';

/**
 * 交易自动分类规则
 * - keyword：不区分大小写包含匹配
 * - priority：越大越优先；同 priority 取第一条
 * - enabled：false 的规则跳过
 */
export interface TxRule {
  id?: number;
  keyword: string;
  matchField: RuleMatchField;
  categoryId: number;
  priority: number;
  enabled: boolean;
  createdAt: number;
}

// ─────────────────────────── 常量 / Hook ───────────────────────────

/** 默认空间 id（兼容老数据）；前端语义 0 = "全部空间"（不过滤）。 */
export const DEFAULT_SPACE_ID = 1;

/**
 * 在 React 组件中读取当前空间 id（来自 spaceIdAtom）。
 * 单一来源：所有需要按空间过滤的地方都通过此 hook 拿值。
 */
export function useSpaceId(): number {
  return useAtomValue(spaceIdAtom);
}
