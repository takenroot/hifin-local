/**
 * AI 助手 → 财务概况聚合
 *
 * 输入来自 REST（/api/transactions、/api/accounts、/api/goals、/api/categories），
 * 在前端聚合成供 AI 模型 system prompt 使用的快照。
 * 纯函数部分（buildFinancialSnapshot / snapshotToText）保持不变。
 *
 * 输出结构：
 *   {
 *     generatedAt: ISO 时间,
 *     accountCount: number,
 *     netAsset: number,
 *     monthIncome: number,
 *     monthExpense: number,
 *     topExpenseCategories: [{ name, amount }],
 *     goalProgress: [{ name, currentAmount, targetAmount, percent }]
 *   }
 */
import dayjs from 'dayjs';
import type { Account, Goal, Transaction, Category } from '@/db';

export interface AiFinancialSnapshot {
  generatedAt: string;
  accountCount: number;
  netAsset: number;
  monthIncome: number;
  monthExpense: number;
  topExpenseCategories: Array<{ name: string; amount: number }>;
  goalProgress: Array<{
    name: string;
    currentAmount: number;
    targetAmount: number;
    percent: number;
  }>;
}

/** 净资产：与看板逻辑一致（includeInNetAsset=true；负债视为减项） */
function calcNetAsset(accounts: Account[]): number {
  let asset = 0;
  let debt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') {
      debt += -a.balance; // ISSUE-005：正余额信用账户是资产（退款在途），负余额才是欠款
    } else {
      asset += a.balance;
    }
  }
  return asset - debt;
}

/** 本月收入 */
function sumMonthIncome(transactions: Transaction[]): number {
  const start = dayjs().startOf('month').valueOf();
  const end = dayjs().endOf('month').valueOf();
  let s = 0;
  for (const t of transactions) {
    if (t.type !== 'income') continue;
    if (t.includeInAsset === false) continue;
    if (t.date >= start && t.date <= end) s += t.amount;
  }
  return s;
}

/** 本月支出 */
function sumMonthExpense(transactions: Transaction[]): number {
  const start = dayjs().startOf('month').valueOf();
  const end = dayjs().endOf('month').valueOf();
  let s = 0;
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (t.includeInAsset === false) continue;
    if (t.date >= start && t.date <= end) s += t.amount;
  }
  return s;
}

/** 前 N 大支出分类（按金额降序） */
function topExpenseCategories(
  transactions: Transaction[],
  categories: Category[],
  limit = 5,
): Array<{ name: string; amount: number }> {
  const start = dayjs().startOf('month').valueOf();
  const end = dayjs().endOf('month').valueOf();
  const map = new Map<number, number>();
  for (const t of transactions) {
    if (t.type !== 'expense') continue;
    if (t.includeInAsset === false) continue;
    if (t.date < start || t.date > end) continue;
    if (t.categoryId == null) continue;
    map.set(t.categoryId, (map.get(t.categoryId) ?? 0) + t.amount);
  }
  const arr = Array.from(map.entries()).map(([cid, amount]) => {
    const cat = categories.find((c) => c.id === cid);
    return { name: cat?.name ?? '未分类', amount };
  });
  arr.sort((a, b) => b.amount - a.amount);
  return arr.slice(0, limit);
}

/** 目标进度 */
function goalProgress(goals: Goal[]) {
  return goals.map((g) => {
    const percent = g.targetAmount > 0 ? (g.currentAmount / g.targetAmount) * 100 : 0;
    return {
      name: g.name,
      currentAmount: g.currentAmount,
      targetAmount: g.targetAmount,
      percent: Math.round(percent * 10) / 10,
    };
  });
}

/** 主入口 */
export function buildFinancialSnapshot(input: {
  accounts: Account[];
  transactions: Transaction[];
  goals: Goal[];
  categories: Category[];
}): AiFinancialSnapshot {
  const { accounts, transactions, goals, categories } = input;
  return {
    generatedAt: new Date().toISOString(),
    accountCount: accounts.length,
    netAsset: calcNetAsset(accounts),
    monthIncome: sumMonthIncome(transactions),
    monthExpense: sumMonthExpense(transactions),
    topExpenseCategories: topExpenseCategories(transactions, categories, 5),
    goalProgress: goalProgress(goals),
  };
}

/** 序列化为模型可读的纯文本（JSON 体积小，便于嵌入 prompt） */
export function snapshotToText(snap: AiFinancialSnapshot): string {  const fmt = (n: number) => n.toFixed(2);
  const lines: string[] = [];
  lines.push(`生成时间: ${snap.generatedAt}`);
  lines.push(`账户数: ${snap.accountCount}`);
  lines.push(`净资产: ¥${fmt(snap.netAsset)}`);
  lines.push(`本月收入: ¥${fmt(snap.monthIncome)}`);
  lines.push(`本月支出: ¥${fmt(snap.monthExpense)}`);
  if (snap.topExpenseCategories.length > 0) {
    lines.push('本月支出前 5 大分类:');
    snap.topExpenseCategories.forEach((c, i) => {
      lines.push(`  ${i + 1}. ${c.name}: ¥${fmt(c.amount)}`);
    });
  } else {
    lines.push('本月支出前 5 大分类: 暂无数据');
  }
  if (snap.goalProgress.length > 0) {
    lines.push('目标进度:');
    snap.goalProgress.forEach((g) => {
      lines.push(`  - ${g.name}: ¥${fmt(g.currentAmount)} / ¥${fmt(g.targetAmount)} (${g.percent}%)`);
    });
  } else {
    lines.push('目标进度: 暂无目标');
  }
  return lines.join('\n');
}

/* ───────────────────── REST 取数 + 聚合入口 ───────────────────── */

/** SQLite INTEGER 0/1 ↔ boolean。null / undefined 视为 false。 */
function bit(value: number | boolean | null | undefined): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return value != null;
}

function opt<T>(v: T | null | undefined): T | undefined {
  return v == null ? undefined : v;
}

async function fetchJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return (await r.json()) as T;
}

/** 空间过滤：sid=0 表示"全部空间"，core 用 spaceId 查询参数过滤。 */
function spaceQuery(spaceId: number | undefined): string {
  return spaceId != null && spaceId !== 0 ? `?spaceId=${spaceId}` : '';
}

interface RestAccountRow {
  id: number;
  name: string;
  type: string;
  balance: number;
  includeInNetAsset: number | boolean;
}

interface RestTransactionRow {
  id: number;
  type: string;
  name: string;
  amount: number;
  date: number;
  categoryId?: number | null;
  accountId: number;
  includeInAsset: number | boolean;
}

interface RestGoalRow {
  id: number;
  kind: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
}

interface RestCategoryRow {
  id: number;
  name: string;
  group: string;
  type: string;
}

/**
 * 从 REST 拉取当前空间的财务数据并聚合成快照。
 *
 * 并行请求 /api/accounts、/api/transactions、/api/goals、/api/categories；
 * 任一端点失败即整体失败（调用方负责降级），避免把"半份数据"喂给模型。
 */
export async function fetchFinancialSnapshot(
  spaceId?: number,
): Promise<AiFinancialSnapshot> {
  const q = spaceQuery(spaceId);
  const [accountRows, txRows, goalRows, catRows] = await Promise.all([
    fetchJson<RestAccountRow[]>(`/api/accounts${q}`),
    fetchJson<RestTransactionRow[]>(`/api/transactions${q}`),
    fetchJson<RestGoalRow[]>(`/api/goals${q}`),
    // categories 是全局资源，无 spaceId 过滤
    fetchJson<RestCategoryRow[]>('/api/categories'),
  ]);

  const accounts: Account[] = accountRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type as Account['type'],
    balance: r.balance,
    includeInNetAsset: bit(r.includeInNetAsset),
    createdAt: 0,
    updatedAt: 0,
  }));

  const transactions: Transaction[] = txRows.map((r) => ({
    id: r.id,
    type: r.type as Transaction['type'],
    name: r.name,
    amount: r.amount,
    date: r.date,
    categoryId: opt(r.categoryId),
    accountId: r.accountId,
    includeInAsset: bit(r.includeInAsset),
    createdAt: 0,
  }));

  const goals: Goal[] = goalRows.map((r) => ({
    id: r.id,
    kind: r.kind as Goal['kind'],
    name: r.name,
    targetAmount: r.targetAmount,
    currentAmount: r.currentAmount,
    createdAt: 0,
  }));

  const categories: Category[] = catRows.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group,
    type: r.type as Category['type'],
  }));

  return buildFinancialSnapshot({ accounts, transactions, goals, categories });
}