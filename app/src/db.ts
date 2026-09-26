/**
 * HiFin 本地数据库（Dexie / IndexedDB）
 *
 * 启动时通过 ensureSeed() 自动写入默认分类 / 默认标签 / 默认空间。
 * 所有 id 字段均为自增 number。
 *
 * v4：新增 spaces 表与空间过滤（accounts/transactions/goals/budgets
 *     都带可选 spaceId 字段）。records 无 spaceId 视为属于默认空间 1。
 */

import Dexie, { type Table } from 'dexie';
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

export interface KvItem {
  key: string;
  value: unknown;
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

// ─────────────────────────── Dexie 数据库 ───────────────────────────

export class HiFinDB extends Dexie {
  accounts!: Table<Account, number>;
  transactions!: Table<Transaction, number>;
  goals!: Table<Goal, number>;
  categories!: Table<Category, number>;
  tags!: Table<Tag, number>;
  merchants!: Table<Merchant, number>;
  reports!: Table<Report, number>;
  aiModels!: Table<AiModel, number>;
  budgets!: Table<Budget, number>;
  rules!: Table<TxRule, number>;
  kv!: Table<KvItem, string>;
  spaces!: Table<Space, number>;

  constructor() {
    super('hifin');
    this.version(1).stores({
      accounts: '++id, type, name, includeInNetAsset, createdAt',
      transactions: '++id, type, date, accountId, toAccountId, categoryId, merchantId, createdAt',
      goals: '++id, kind, subtype, deadline, createdAt',
      categories: '++id, type, group, name',
      tags: '++id, name',
      merchants: '++id, name',
      reports: '++id, createdAt',
      aiModels: '++id, name',
      kv: '&key',
    });
    // v2：新增 budgets 表（保留 v1 定义，Dexie 增量迁移）
    this.version(2).stores({
      accounts: '++id, type, name, includeInNetAsset, createdAt',
      transactions: '++id, type, date, accountId, toAccountId, categoryId, merchantId, createdAt',
      goals: '++id, kind, subtype, deadline, createdAt',
      categories: '++id, type, group, name',
      tags: '++id, name',
      merchants: '++id, name',
      reports: '++id, createdAt',
      aiModels: '++id, name',
      budgets: '++id, categoryId, period, createdAt',
      kv: '&key',
    });
    // v3：新增 rules 表（自动归类规则）
    this.version(3).stores({
      accounts: '++id, type, name, includeInNetAsset, createdAt',
      transactions: '++id, type, date, accountId, toAccountId, categoryId, merchantId, createdAt',
      goals: '++id, kind, subtype, deadline, createdAt',
      categories: '++id, type, group, name',
      tags: '++id, name',
      merchants: '++id, name',
      reports: '++id, createdAt',
      aiModels: '++id, name',
      budgets: '++id, categoryId, period, createdAt',
      rules: '++id, priority',
      kv: '&key',
    });
    // v4：新增 spaces 表 + accounts/transactions/goals/budgets 加 spaceId 字段
    // （spaceId 不建索引，保持 stores schema 与 v3 一致，字段通过 ensureSeed 迁移保证）
    this.version(4).stores({
      accounts: '++id, type, name, includeInNetAsset, createdAt',
      transactions: '++id, type, date, accountId, toAccountId, categoryId, merchantId, createdAt',
      goals: '++id, kind, subtype, deadline, createdAt',
      categories: '++id, type, group, name',
      tags: '++id, name',
      merchants: '++id, name',
      reports: '++id, createdAt',
      aiModels: '++id, name',
      budgets: '++id, categoryId, period, createdAt',
      rules: '++id, priority',
      kv: '&key',
      spaces: '++id, name',
    });
  }
}

export const db = new HiFinDB();

/** 默认空间 id（兼容老数据）；前端语义 0 = "全部空间"（不过滤）。 */
export const DEFAULT_SPACE_ID = 1;

// ─────────────────────────── Seed 数据 ───────────────────────────

/** 默认分组 + 分类（支出 8 组 ≥28 项；收入若干） */
const SEED_CATEGORIES: Array<Omit<Category, 'id'>> = [
  // 餐饮
  { name: '日常餐饮', group: '餐饮', type: 'expense', icon: '🍱', color: '#f97316' },
  { name: '外卖', group: '餐饮', type: 'expense', icon: '🥡', color: '#fb923c' },
  { name: '咖啡奶茶', group: '餐饮', type: 'expense', icon: '☕', color: '#b45309' },
  { name: '聚餐', group: '餐饮', type: 'expense', icon: '🍻', color: '#ea580c' },
  // 交通
  { name: '公共交通', group: '交通', type: 'expense', icon: '🚌', color: '#0ea5e9' },
  { name: '打车', group: '交通', type: 'expense', icon: '🚖', color: '#0284c7' },
  { name: '加油', group: '交通', type: 'expense', icon: '⛽', color: '#0369a1' },
  { name: '停车费', group: '交通', type: 'expense', icon: '🅿️', color: '#1d4ed8' },
  // 购物
  { name: '日用百货', group: '购物', type: 'expense', icon: '🛒', color: '#a855f7' },
  { name: '服饰', group: '购物', type: 'expense', icon: '👕', color: '#9333ea' },
  { name: '美妆护肤', group: '购物', type: 'expense', icon: '💄', color: '#c026d3' },
  { name: '数码电器', group: '购物', type: 'expense', icon: '💻', color: '#7e22ce' },
  // 住房
  { name: '房租', group: '住房', type: 'expense', icon: '🏠', color: '#ef4444' },
  { name: '房贷', group: '住房', type: 'expense', icon: '🏦', color: '#dc2626' },
  { name: '物业水电', group: '住房', type: 'expense', icon: '💡', color: '#f87171' },
  // 娱乐
  { name: '电影演出', group: '娱乐', type: 'expense', icon: '🎬', color: '#ec4899' },
  { name: '游戏', group: '娱乐', type: 'expense', icon: '🎮', color: '#db2777' },
  { name: '运动健身', group: '娱乐', type: 'expense', icon: '🏃', color: '#be185d' },
  { name: '旅行', group: '娱乐', type: 'expense', icon: '✈️', color: '#e11d48' },
  // 医疗
  { name: '看病就医', group: '医疗', type: 'expense', icon: '🏥', color: '#10b981' },
  { name: '药品保健', group: '医疗', type: 'expense', icon: '💊', color: '#059669' },
  { name: '保险', group: '医疗', type: 'expense', icon: '🛡️', color: '#047857' },
  // 教育
  { name: '书籍', group: '教育', type: 'expense', icon: '📚', color: '#6366f1' },
  { name: '课程培训', group: '教育', type: 'expense', icon: '🎓', color: '#4f46e5' },
  // 通讯 / 服务 / 其他
  { name: '通讯话费', group: '通讯', type: 'expense', icon: '📱', color: '#0d9488' },
  { name: '订阅服务', group: '订阅', type: 'expense', icon: '📺', color: '#0891b2' },
  { name: '人情往来', group: '社交', type: 'expense', icon: '🎁', color: '#f59e0b' },
  { name: '其他支出', group: '其他', type: 'expense', icon: '💸', color: '#6b7280' },

  // 收入
  { name: '工资', group: '工资', type: 'income', icon: '💰', color: '#10b981' },
  { name: '奖金', group: '工资', type: 'income', icon: '🎉', color: '#22c55e' },
  { name: '兼职', group: '副业', type: 'income', icon: '🧰', color: '#16a34a' },
  { name: '投资收益', group: '投资', type: 'income', icon: '📈', color: '#15803d' },
  { name: '其他收入', group: '其他', type: 'income', icon: '💵', color: '#65a30d' },
];

const SEED_TAGS: Array<Omit<Tag, 'id'>> = [
  { name: '必要', color: '#6366f1' },
  { name: '可选', color: '#f59e0b' },
  { name: '冲动消费', color: '#ef4444' },
  { name: '月度复盘', color: '#10b981' },
];

/** 默认空间（首次启动写入；老用户升级时由 ensureSeed 兜底） */
const SEED_SPACE: Omit<Space, 'id'> = {
  name: '默认空间',
  createdAt: 0, // 真实写入时覆写
};

/** 首次启动写入默认分类 / 标签 / 空间，并把历史记录的 spaceId 补成 1 */
export async function ensureSeed(): Promise<void> {
  const catCount = await db.categories.count();
  if (catCount === 0) {
    await db.categories.bulkAdd(SEED_CATEGORIES);
  }
  const tagCount = await db.tags.count();
  if (tagCount === 0) {
    await db.tags.bulkAdd(SEED_TAGS);
  }

  // 空间必须存在 id=1（默认空间）；幂等保证
  const defaultSpace = await db.spaces.get(DEFAULT_SPACE_ID);
  if (!defaultSpace) {
    const now = Date.now();
    await db.spaces.add({ ...SEED_SPACE, createdAt: now });
  }
  await migrateLegacySpaceIds();
}

/**
 * v4 迁移辅助：把所有无 spaceId 的存量记录补成默认空间 1。
 * 已存在的 spaceId 视为可信（用户在 v4 后手动改过则保留）。
 */
async function migrateLegacySpaceIds(): Promise<void> {
  await Promise.all([
    backfillSpaceId(db.accounts),
    backfillSpaceId(db.transactions),
    backfillSpaceId(db.goals),
    backfillSpaceId(db.budgets),
  ]);
}

async function backfillSpaceId<T extends { id?: number; spaceId?: number }>(
  table: Table<T, number>,
): Promise<void> {
  await table
    .filter((row) => row.spaceId === undefined)
    .modify((row) => {
      row.spaceId = DEFAULT_SPACE_ID;
    });
}

/**
 * 在 React 组件中读取当前空间 id（来自 spaceIdAtom）。
 * 单一来源：所有需要按空间过滤的地方都通过此 hook 拿值。
 */
export function useSpaceId(): number {
  return useAtomValue(spaceIdAtom);
}