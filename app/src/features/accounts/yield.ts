/**
 * 账户年收益率：输入校验与展示口径（纯函数，无 fetch / 无 React）
 * ------------------------------------------------------------------
 * 表单里「年收益率（%）」是选填字段：留空 = 不关心这个账户的收益，留着 = 每年
 * 提醒补录一次。因此这里的校验必须把"留空"当成**合法**，而不是当成 0；
 * 只有用户真的填了字、又超出 -100~100 或根本不是数字，才拦下提交。
 *
 * 本项目的 vitest 跑在 node 环境（无 jsdom / testing-library），
 * 把校验与文案口径抽成纯函数，才能用单测覆盖"留空可提交 / 范围校验"这两条验收。
 */
import type { Account } from '@/db';
import { formatMoney, isDebtType } from './format';

/** 年收益率合法区间（百分比）：-100 ~ 100（投资可能亏损，负值合法） */
export const YIELD_MIN = -100;
export const YIELD_MAX = 100;

export interface YieldValidation {
  /** 能否提交；留空也算合法 */
  ok: boolean;
  /** 留空或非法都是 null；合法时为提交用的数值 */
  value: number | null;
  /** 用户是否留空：留空时提交**不调用** yield 接口（而不是 PUT 0） */
  empty: boolean;
  /** 非法原因（给表单红字用），合法时为 null */
  error: string | null;
}

/**
 * 输入 → 数字的宽松解析。
 *
 * 不能复用 format.ts 的 parseAmount：那个函数把不合法输入兜底成 0，
 * 而这里需要区分"用户填了 0"和"用户填了 abc"。
 */
function toNumber(input: string): number {
  const cleaned = input.trim().replace(/[, ]/g, '');
  if (cleaned === '') return NaN;
  return Number(cleaned);
}

/**
 * 校验表单里的年收益率输入。
 *
 * - 留空（空串 / 全空格）→ ok + empty，提交时不写 yield
 * - 非数字（含 "2.1%" 这类带单位的串）→ 报错
 * - < -100 或 > 100 → 报错（-100 与 100 都合法，负收益合法）
 */
export function validateYieldInput(input: string): YieldValidation {
  const trimmed = input.trim();
  if (trimmed === '') {
    return { ok: true, value: null, empty: true, error: null };
  }
  const n = toNumber(trimmed);
  if (!Number.isFinite(n)) {
    return {
      ok: false,
      value: null,
      empty: false,
      error: `请输入 ${YIELD_MIN}-${YIELD_MAX} 之间的数字`,
    };
  }
  if (n < YIELD_MIN) {
    return { ok: false, value: null, empty: false, error: `年收益率不能小于 ${YIELD_MIN}%` };
  }
  if (n > YIELD_MAX) {
    return { ok: false, value: null, empty: false, error: `年收益率不能大于 ${YIELD_MAX}%` };
  }
  return { ok: true, value: n, empty: false, error: null };
}

/** 百分比展示：2 → "2"，2.1 → "2.1"，2.10 → "2.1"（去掉无意义的小数尾零） */
export function formatYieldPercent(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  // 先按 4 位小数收敛浮点误差（0.1+0.2 这类），再交给 String 去掉尾零
  return String(Math.round(percent * 10000) / 10000);
}

/** 预计年收益 = 当前余额 × 收益率 */
export function estimatedAnnualYield(balance: number, percent: number): number {
  return balance * (percent / 100);
}

/** 账户卡片的收益率展示结果；整行不展示时返回 null */
export interface YieldDisplay {
  /** `年收益率 2.1%` */
  percentText: string;
  /** `预计年收益 ¥ 210.00`；余额 <= 0 时为 null（负余额乘出来是负收益，不如不显示） */
  estimateText: string | null;
  /** 两段拼好的整行文案 */
  fullText: string;
}

/**
 * 账户卡片上的年收益率展示口径。
 *
 * 返回 null（不展示）的三种情况：
 *   1. 负债账户（花呗等）：负债恒红 + "负债"角标，再挂一行"年收益率"只会
 *      让人误以为欠款会产生利息；契约也明确要求负债账户不展示该字段。
 *   2. 没有填过收益率：latestYield 缺失 / 为 null / 数据异常。
 *   3. 收益率不是有限数：容错 core 尚未上线或脏数据。
 */
export function accountYieldDisplay(
  account: Pick<Account, 'type' | 'balance' | 'latestYield'>,
): YieldDisplay | null {
  if (isDebtType(account.type)) return null;
  const latest = account.latestYield;
  if (!latest || typeof latest.yieldPercent !== 'number' || !Number.isFinite(latest.yieldPercent)) {
    return null;
  }
  const percentText = `年收益率 ${formatYieldPercent(latest.yieldPercent)}%`;
  // 余额 <= 0（欠款 / 空户）不给"预计"：乘出来是负数或 0，对用户没有参考价值
  const estimateText =
    account.balance > 0
      ? `预计年收益 ${formatMoney(estimatedAnnualYield(account.balance, latest.yieldPercent))}`
      : null;
  return {
    percentText,
    estimateText,
    fullText: estimateText ? `${percentText} · ${estimateText}` : percentText,
  };
}

/** 回填表单用：只回填"当前年"的值，往年记录不写进今年的输入框 */
export function yieldInputValue(
  latestYield: { year: number; yieldPercent: number } | null | undefined,
  currentYear: number,
): string {
  if (!latestYield || latestYield.year !== currentYear) return '';
  if (!Number.isFinite(latestYield.yieldPercent)) return '';
  return String(latestYield.yieldPercent);
}
