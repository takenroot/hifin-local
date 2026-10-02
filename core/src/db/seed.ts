/**
 * hifin-core 数据库种子层
 * - 默认空间 (id=1, "默认空间")
 * - 33 个默认分类（与 app/src/db.ts SEED_CATEGORIES 1:1 对齐）
 * - 4 个默认标签：必要 / 可选 / 冲动消费 / 月度复盘
 * - 全部幂等：先查后插 + UNIQUE(name, "group", type) 由 SQLite 在分类层面进一步保护
 */

import type { DatabaseType } from './connection.js';
import type { CategoryType } from './schema.js';

export const DEFAULT_SPACE_ID = 1;

/** 与 app/src/db.ts SEED_CATEGORIES 保持完全一致。 */
const SEED_CATEGORIES: ReadonlyArray<{
  name: string;
  group: string;
  type: CategoryType;
  icon: string;
  color: string;
}> = [
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

const SEED_TAGS: ReadonlyArray<{ name: string; color: string }> = [
  { name: '必要', color: '#6366f1' },
  { name: '可选', color: '#f59e0b' },
  { name: '冲动消费', color: '#ef4444' },
  { name: '月度复盘', color: '#10b981' },
];

const DEFAULT_SPACE_NAME = '默认空间';

/** 幂等写入默认空间 + 33 个默认分类 + 4 个默认标签。 */
export function ensureSeed(db: DatabaseType): void {
  ensureDefaultSpace(db);
  ensureDefaultCategories(db);
  ensureDefaultTags(db);
}

function ensureDefaultSpace(db: DatabaseType): void {
  // 保证默认空间 id=1 存在；若不存在则插入（INSERT OR IGNORE 防止重复）。
  const row = db
    .prepare('SELECT id FROM spaces WHERE id = ?')
    .get(DEFAULT_SPACE_ID) as { id: number } | undefined;
  if (row !== undefined) return;

  db.prepare(
    'INSERT OR IGNORE INTO spaces (id, name, createdAt) VALUES (?, ?, ?)',
  ).run(DEFAULT_SPACE_ID, DEFAULT_SPACE_NAME, Date.now());
}

function ensureDefaultCategories(db: DatabaseType): void {
  // categories 表没有 UNIQUE 约束 → 用先查后插保证幂等
  const exists = db.prepare(
    'SELECT 1 FROM categories WHERE name = ? AND "group" = ? AND type = ?',
  );
  const insert = db.prepare(
    'INSERT INTO categories (name, "group", type, icon, color) VALUES (?, ?, ?, ?, ?)',
  );
  const tx = db.transaction((cats: typeof SEED_CATEGORIES) => {
    for (const c of cats) {
      if (exists.get(c.name, c.group, c.type) === undefined) {
        insert.run(c.name, c.group, c.type, c.icon, c.color);
      }
    }
  });
  tx(SEED_CATEGORIES);
}

function ensureDefaultTags(db: DatabaseType): void {
  // tags 表同样没有 UNIQUE 约束 → 先查后插
  const exists = db.prepare('SELECT 1 FROM tags WHERE name = ?');
  const insert = db.prepare('INSERT INTO tags (name, color) VALUES (?, ?)');
  const tx = db.transaction((tags: typeof SEED_TAGS) => {
    for (const t of tags) {
      if (exists.get(t.name) === undefined) {
        insert.run(t.name, t.color);
      }
    }
  });
  tx(SEED_TAGS);
}