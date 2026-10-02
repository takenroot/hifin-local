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
  createdAt INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK(type IN ('need_password','password_error','import_success','import_failed')),
  title TEXT NOT NULL,
  message TEXT,
  bill_uid INTEGER,
  platform TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','resolved','dismissed','failed')),
  retry_count INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

-- 常用索引
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications(status);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(accountId);
CREATE INDEX IF NOT EXISTS idx_tx_category ON transactions(categoryId);
CREATE INDEX IF NOT EXISTS idx_tx_space ON transactions(spaceId);
CREATE INDEX IF NOT EXISTS idx_acc_space ON accounts(spaceId);
CREATE INDEX IF NOT EXISTS idx_goal_space ON goals(spaceId);
CREATE INDEX IF NOT EXISTS idx_budget_space ON budgets(spaceId);
`;

// ── 与 app/src/db.ts 对齐的 TypeScript 类型 ──

export type AccountType = 'fund' | 'asset' | 'social' | 'invest' | 'other' | 'credit' | 'debt';
export type TransactionType = 'expense' | 'income' | 'transfer' | 'excluded';
export type GoalKind = 'saving' | 'repayment';
export type CategoryType = 'expense' | 'income';
export type BudgetPeriod = 'monthly' | 'yearly';
export type RuleMatchField = 'name' | 'merchant' | 'remark';

export interface SpaceRow { id?: number; name: string; createdAt: number; }
export interface AccountRow { id?: number; name: string; type: AccountType; balance: number; remark?: string; tagIds?: string; includeInNetAsset: number; spaceId?: number; createdAt: number; updatedAt: number; }
export interface TransactionRow { id?: number; type: TransactionType; name: string; amount: number; date: number; categoryId?: number; accountId: number; toAccountId?: number; remark?: string; tagIds?: string; merchantId?: number; includeInAsset: number; spaceId?: number; createdAt: number; }
export interface GoalRow { id?: number; kind: GoalKind; subtype?: string; name: string; targetAmount: number; currentAmount: number; deadline?: number; accountId?: number; icon?: string; color?: string; spaceId?: number; createdAt: number; }
export interface CategoryRow { id?: number; name: string; group: string; type: CategoryType; icon?: string; color?: string; }
export interface TagRow { id?: number; name: string; color?: string; }
export interface MerchantRow { id?: number; name: string; remark?: string; }
export interface ReportRow { id?: number; name: string; description?: string; template?: string; icon?: string; config?: string; createdAt: number; }
export interface AiModelRow { id?: number; name: string; model: string; endpoint: string; apiKey?: string; }
export interface BudgetRow { id?: number; name: string; categoryId?: number; amount: number; period: BudgetPeriod; spaceId?: number; createdAt: number; }
export interface RuleRow { id?: number; keyword: string; matchField: RuleMatchField; categoryId: number; priority: number; enabled: number; createdAt: number; }
export type NotificationType = 'need_password' | 'password_error' | 'import_success' | 'import_failed';
export type NotificationStatus = 'pending' | 'resolved' | 'dismissed' | 'failed';
export interface NotificationRow { id?: number; type: NotificationType; title: string; message?: string; bill_uid?: number; platform?: string; status: NotificationStatus; retry_count: number; createdAt: number; updatedAt: number; }
export interface KvRow { key: string; value?: string; }
