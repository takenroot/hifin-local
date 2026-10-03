/**
 * hifin-core 数据库模块聚合入口
 * - re-export connection / migrate / seed / schema 全量类型 + 常量
 * - 上层（routes / services / cli）一律从此处导入，避免散落
 */

export {
  openDatabase,
  getDb,
  resetDb,
  getDbPath,
  type DatabaseType,
} from './connection.js';

export {
  migrate,
  getUserVersion,
  setUserVersion,
  getColumns,
  ensureColumns,
  ensureNotificationsShape,
  TX_EXTERNAL_ID_INDEX_SQL,
  NOTIFICATIONS_V3_SQL,
  CURRENT_SCHEMA_VERSION,
} from './migrate.js';

export {
  ensureSeed,
  DEFAULT_SPACE_ID,
} from './seed.js';

export {
  SCHEMA_SQL,
  // 类型
  type AccountType,
  type TransactionType,
  type GoalKind,
  type CategoryType,
  type BudgetPeriod,
  type RuleMatchField,
  type TxSource,
  DEFAULT_TX_SOURCE,
  type SpaceRow,
  type AccountRow,
  type TransactionRow,
  type GoalRow,
  type CategoryRow,
  type TagRow,
  type MerchantRow,
  type ReportRow,
  type AiModelRow,
  type BudgetRow,
  type RuleRow,
  type KvRow,
  type AccountYieldRow,
  type NotificationType,
  type NotificationStatus,
  type NotificationRow,
} from './schema.js';