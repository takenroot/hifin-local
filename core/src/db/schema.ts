/**
 * hifin-core SQLite schema
 * 与 app/src/db.ts (Dexie v4) 保持 1:1 映射
 * 所有 id 均为 INTEGER PRIMARY KEY AUTOINCREMENT
 * 时间戳均为 INTEGER (ms)
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('fund','asset','social','invest','other','credit','debt')),
  balance REAL NOT NULL DEFAULT 0,
  remark TEXT,
  tagIds TEXT,               -- JSON number[]
  includeInNetAsset INTEGER NOT NULL DEFAULT 1,
  spaceId INTEGER DEFAULT 1,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('expense','income','transfer','excluded')),
  name TEXT NOT NULL,
  amount REAL NOT NULL CHECK(amount > 0),
  date INTEGER NOT NULL,
  categoryId INTEGER,
  accountId INTEGER NOT NULL,
  toAccountId INTEGER,
  remark TEXT,
  tagIds TEXT,               -- JSON number[]
  merchantId INTEGER,
  includeInAsset INTEGER NOT NULL DEFAULT 1,
  spaceId INTEGER DEFAULT 1,
  createdAt INTEGER NOT NULL,
  -- ── 账单溯源四件套（v2 迁移新增；全部 nullable，手工记账/老数据一律 NULL）──
  source TEXT,               -- 'alipay' / 'wechat' / 'manual' / 'csv'
  externalId TEXT,           -- 平台交易单号（微信「交易单号」/ 支付宝「交易订单号」）
  paymentMethod TEXT,        -- 支付方式主渠道（组合支付取 & 前段）
  status TEXT                -- 交易状态原文（"交易成功" / "已全额退款" …）
);

CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('saving','repayment')),
  subtype TEXT,
  name TEXT NOT NULL,
  targetAmount REAL NOT NULL DEFAULT 0,
  currentAmount REAL NOT NULL DEFAULT 0,
  deadline INTEGER,
  accountId INTEGER,
  icon TEXT,
  color TEXT,
  spaceId INTEGER DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  "group" TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('expense','income')),
  icon TEXT,
  color TEXT
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  color TEXT
);

CREATE TABLE IF NOT EXISTS merchants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  template TEXT,
  icon TEXT,
  config TEXT,               -- JSON ReportConfig
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aiModels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  apiKey TEXT
);

CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  categoryId INTEGER,
  amount REAL NOT NULL,
  period TEXT NOT NULL CHECK(period IN ('monthly','yearly')),
  spaceId INTEGER DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword TEXT NOT NULL,
  matchField TEXT NOT NULL CHECK(matchField IN ('name','merchant','remark')),
  categoryId INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  createdAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT                 -- JSON
);

-- payload 是 v3 迁移新增的通用业务载荷列（JSON 文本）。
-- 目前只有 type='yield-reminder' 用它装 {accountId, year}；
-- 其余通知类型留 NULL，读侧一律容错。
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('need_password','password_error','import_success','import_failed','yield-reminder','ai-insight')),
  title TEXT NOT NULL,
  message TEXT,
  bill_uid INTEGER,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed','failed','expired')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  payload TEXT                -- JSON；yield-reminder 为 {"accountId":N,"year":Y}
);

-- 账户年度收益历史（v3 建表，v4 语义改为"金额"）：每个账户每年一条。
-- UNIQUE(accountId, year) 让"一年只能有一条"由数据库兜底，
-- REST 的 PUT 端点据此做 upsert，调度器据此判断"是否已填"。
--
-- annualIncome = 该年实际收益金额（元）。
-- 刻意**不是**年收益率：零钱通/余额宝这类余额天天在变，"余额 × 收益率"推出来的
-- 预估数没有参考价值；用户要的是"2025 年这块钱实际赚了 350 块"，一年手动记一次。
CREATE TABLE IF NOT EXISTS accountYields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accountId INTEGER NOT NULL,
  year INTEGER NOT NULL,
  annualIncome REAL NOT NULL,  -- 该年实际收益金额（元）；负值合法，容纳极端亏损
  note TEXT,
  createdAt INTEGER NOT NULL,
  UNIQUE(accountId, year)
);

-- 常用索引
--
-- 注意：transactions(source, externalId) 的**部分唯一索引**刻意不写在这里。
-- 本段由 migrate() 在"补列"之前执行，老库上此时 source/externalId 还不存在，
-- 建索引会直接报 no such column。索引 DDL 见 migrate.ts 的 TX_EXTERNAL_ID_INDEX_SQL。
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_notif_type_status ON notifications(type, status);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(accountId);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(categoryId);
CREATE INDEX IF NOT EXISTS idx_tx_space ON transactions(spaceId);
CREATE INDEX IF NOT EXISTS idx_acc_space ON accounts(spaceId);
CREATE INDEX IF NOT EXISTS idx_goal_space ON goals(spaceId);
CREATE INDEX IF NOT EXISTS idx_budget_space ON budgets(spaceId);
CREATE INDEX IF NOT EXISTS idx_yield_year ON accountYields(year);
`;

// ── 与 app/src/db.ts 对齐的 TypeScript 类型 ──

export type AccountType = 'fund' | 'asset' | 'social' | 'invest' | 'other' | 'credit' | 'debt';
export type TransactionType = 'expense' | 'income' | 'transfer' | 'excluded';
export type GoalKind = 'saving' | 'repayment';
export type CategoryType = 'expense' | 'income';
export type BudgetPeriod = 'monthly' | 'yearly';
export type RuleMatchField = 'name' | 'merchant' | 'remark';
/**
 * 交易来源。列本身是裸 TEXT（不加 CHECK），因为银行邮件账单等第三方来源
 * 也可能冒出来；这里只把"我们自己会写入的四个值"固化成类型。
 */
export type TxSource = 'alipay' | 'wechat' | 'manual' | 'csv';

/** 手工记账 / REST 直写的默认来源 */
export const DEFAULT_TX_SOURCE: TxSource = 'manual';

export interface SpaceRow { id?: number; name: string; createdAt: number; }
export interface AccountRow { id?: number; name: string; type: AccountType; balance: number; remark?: string; tagIds?: string; includeInNetAsset: number; spaceId?: number; createdAt: number; updatedAt: number; }
export interface TransactionRow { id?: number; type: TransactionType; name: string; amount: number; date: number; categoryId?: number; accountId: number; toAccountId?: number; remark?: string; tagIds?: string; merchantId?: number; includeInAsset: number; spaceId?: number; createdAt: number; source?: string | null; externalId?: string | null; paymentMethod?: string | null; status?: string | null; }
export interface GoalRow { id?: number; kind: GoalKind; subtype?: string; name: string; targetAmount: number; currentAmount: number; deadline?: number; accountId?: number; icon?: string; color?: string; spaceId?: number; createdAt: number; }
export interface CategoryRow { id?: number; name: string; group: string; type: CategoryType; icon?: string; color?: string; }
export interface TagRow { id?: number; name: string; color?: string; }
export interface MerchantRow { id?: number; name: string; remark?: string; }
export interface ReportRow { id?: number; name: string; description?: string; template?: string; icon?: string; config?: string; createdAt: number; }
export interface AiModelRow { id?: number; name: string; model: string; endpoint: string; apiKey?: string; }
export interface BudgetRow { id?: number; name: string; categoryId?: number; amount: number; period: BudgetPeriod; spaceId?: number; createdAt: number; }
export interface RuleRow { id?: number; keyword: string; matchField: RuleMatchField; categoryId: number; priority: number; enabled: number; createdAt: number; }
export type NotificationType =
  | 'need_password'
  | 'password_error'
  | 'import_success'
  | 'import_failed'
  /**
   * 账户年收益率催填（v3 新增）。
   * 与账单通知不同，它不带 bill_uid，accountId/year 装在 payload 里。
   */
  | 'yield-reminder'
  /**
   * 自动财务洞察（v5 新增）。month / sections / llmNarrative 等装在 payload 里。
   * 前端通过通知中心 Modal + Dashboard 角标展示。
   */
  | 'ai-insight';
/**
 * pending 待处理 / resolved 已解决 / dismissed 用户忽略 / failed 失败。
 * expired 是 v3 新增的终态：催填窗口（2 月 1 日）已过且用户始终没填，
 * 等价于"这件事到此为止"，与 resolved 区分开是为了让 UI 能说清是补填了还是放弃了。
 */
export type NotificationStatus = 'pending' | 'resolved' | 'dismissed' | 'failed' | 'expired';
export interface NotificationRow { id?: number; type: NotificationType; title: string; message?: string; bill_uid?: number; platform?: string; status: NotificationStatus; retry_count: number; createdAt: number; updatedAt: number; payload?: string | null; }
/**
 * 账户年度收益行（v4 语义）：annualIncome 是**金额（元）**，不是百分比。
 * 例：2025 年零钱通赚了 350 元 → { year: 2025, annualIncome: 350 }。
 * 负值合法（当年亏损），量级由 REST 层限制在 ±999,999,999。
 */
export interface AccountYieldRow { id?: number; accountId: number; year: number; annualIncome: number; note?: string | null; createdAt: number; }
export interface KvRow { key: string; value?: string; }
