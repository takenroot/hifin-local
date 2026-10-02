/**
 * /api/summary 路由 — 看板汇总
 *
 * GET /api/summary?month=YYYY-MM
 *   返回：
 *     - netAsset: 当前净资产（按 calcNetAsset 口径）
 *     - monthIncome / monthExpense: 当月 includeInAsset=true 的 income / expense 合计
 *     - monthNet: monthIncome - monthExpense
 *     - mom: 环比变化（与上一月 monthNet 对比）
 *       - mom.delta: number
 *       - mom.deltaPct: number | null  （环比百分比；上月为 0 时返回 null）
 *     - month: 'YYYY-MM'（回显）
 *
 * 月份边界：使用本地时区 dayjs(YYYY-MM-01).startOf('month') .. endOf('month')+1ms，
 * 与 app/src/features/dashboard/calculations.ts 口径保持一致（半开区间 [start, end)）。
 */
import { Router, type Request, type Response } from 'express';
import { getDb } from './_db.js';
import type { AccountRow, TransactionRow } from '../db/schema.js';

export const summaryRouter = Router();

/** 把 YYYY-MM 字符串解析为 [start, end) 半开区间毫秒戳。 */
function monthRange(monthStr: string): { start: number; end: number } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) return null;
  const year = Number(m[1]);
  const mo = Number(m[2]);
  if (!Number.isFinite(year) || !Number.isFinite(mo) || mo < 1 || mo > 12) {
    return null;
  }
  const start = new Date(year, mo - 1, 1, 0, 0, 0, 0).getTime();
  const end = new Date(year, mo, 1, 0, 0, 0, 0).getTime();
  return { start, end };
}

/** 净资产：参考 calcNetAsset */
function calcNetAsset(accounts: AccountRow[]): number {
  let asset = 0;
  let debt = 0;
  for (const a of accounts) {
    if (!a.includeInNetAsset) continue;
    if (a.type === 'credit' || a.type === 'debt') {
      debt += Math.abs(a.balance);
    } else {
      asset += a.balance;
    }
  }
  return asset - debt;
}

function sumTx(
  txs: TransactionRow[],
  type: 'income' | 'expense',
  start: number,
  end: number,
): number {
  let sum = 0;
  for (const t of txs) {
    if (t.type !== type) continue;
    if (t.includeInAsset === 0) continue;
    if (t.date >= start && t.date < end) sum += t.amount;
  }
  return sum;
}

/** GET /api/summary?month=YYYY-MM */
summaryRouter.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const month = (req.query.month as string | undefined) ?? monthOfToday();
  const range = monthRange(month);
  if (!range) {
    res.status(400).json({ error: 'month 必须是 YYYY-MM 格式' });
    return;
  }

  const accounts = db.prepare('SELECT * FROM accounts').all() as AccountRow[];
  const txs = db
    .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
    .all(range.start, range.end) as TransactionRow[];

  const monthIncome = sumTx(txs, 'income', range.start, range.end);
  const monthExpense = sumTx(txs, 'expense', range.start, range.end);
  const monthNet = monthIncome - monthExpense;

  // 上一月
  const prev = previousMonth(month);
  const prevRange = monthRange(prev);
  let momDelta = 0;
  let momDeltaPct: number | null = null;
  if (prevRange) {
    const prevTxs = db
      .prepare('SELECT * FROM transactions WHERE date >= ? AND date < ?')
      .all(prevRange.start, prevRange.end) as TransactionRow[];
    const prevIncome = sumTx(prevTxs, 'income', prevRange.start, prevRange.end);
    const prevExpense = sumTx(prevTxs, 'expense', prevRange.start, prevRange.end);
    const prevNet = prevIncome - prevExpense;
    momDelta = monthNet - prevNet;
    if (prevNet !== 0) {
      momDeltaPct = (momDelta / Math.abs(prevNet)) * 100;
    }
  }

  res.json({
    month,
    netAsset: calcNetAsset(accounts),
    monthIncome,
    monthExpense,
    monthNet,
    mom: { delta: momDelta, deltaPct: momDeltaPct, previousMonth: prev },
  });
});

function monthOfToday(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${d.getFullYear()}-${m}`;
}

function previousMonth(monthStr: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(monthStr);
  if (!m) return monthStr;
  let year = Number(m[1]);
  let mo = Number(m[2]);
  mo -= 1;
  if (mo === 0) {
    mo = 12;
    year -= 1;
  }
  return `${year}-${String(mo).padStart(2, '0')}`;
}

export const summaryHelpers = { calcNetAsset, sumTx, monthRange };
