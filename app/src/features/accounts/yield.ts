/**
 * 账户年度收益金额：输入校验与展示口径（纯函数，无 fetch / 无 React）
 * ------------------------------------------------------------------
 * 表单里「年度收益（元）」是选填字段：留空 = 不关心这个账户的收益，留着 = 每年
 * 提醒补录一次。因此这里的校验必须把"留空"当成**合法**，而不是当成 0；
 * 只有用户真的填了字、又超出 -999999999 ~ 999999999 或根本不是数字，才拦下提交。
 *
 * 这里记的是**当年实际产生的收益金额**（2025 年零钱通赚了 350 → 填 350），
 * 不是年收益率：余额天天在变，"余额 × 收益率"推出来的预估数对用户没有参考价值。
 * 所以模块里**没有** estimatedAnnualYield 这类推算函数——没有输入就不该有输出。
 *
 * 本项目的 vitest 跑在 node 环境（无 jsdom / testing-library），
 * 把校验与文案口径抽成纯函数，才能用单测覆盖"留空可提交 / 范围校验"这两条验收。
 */
import type { Account } from '@/db';
import { isDebtType } from './format';

/** 年度收益金额合法区间（元）：与 core 的 REST 校验保持同一条线 */
export const AMOUNT_MIN = -999999999;
export const AMOUNT_MAX = 999999999;

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
 * 校验表单里的年度收益金额输入（元）。
 *
 * - 留空（空串 / 全空格）→ ok + empty，提交时不写 yield
 * - 非数字（含 "350 元" 这类带单位的串）→ 报错
 * - < AMOUNT_MIN 或 > AMOUNT_MAX → 报错（两端都合法，负值容纳当年亏损）
 */
export function validateAnnualIncome(input: string): YieldValidation {
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
      // 用「~」分隔：直接拼 "MIN-MAX" 时负下限会连出 "-999999999-999999999" 的双横线
      error: `请输入 ${AMOUNT_MIN} ~ ${AMOUNT_MAX} 之间的数字`,
    };
  }
  if (n < AMOUNT_MIN) {
    return { ok: false, value: null, empty: false, error: `年度收益不能小于 ${AMOUNT_MIN}` };
  }
  if (n > AMOUNT_MAX) {
    return { ok: false, value: null, empty: false, error: `年度收益不能大于 ${AMOUNT_MAX}` };
  }
  return { ok: true, value: n, empty: false, error: null };
}

/**
 * 金额展示：350 → "350.00"，-120.5 → "-120.50"，1234567 → "1,234,567.00"。
 *
 * 刻意不用 format.ts 的 formatMoney：那个函数输出 "¥ 350.00"（币种符号后带空格），
 * 而这里拼的是 "2025 年收益 ¥350.00" 这种贴着写的中文短句，符号后留空会读着别扭。
 */
export function formatAnnualIncome(amount: number): string {
  if (!Number.isFinite(amount)) return '0.00';
  const sign = amount < 0 ? '-' : '';
  const abs = Math.abs(amount);
  const fixed = abs.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${withCommas}.${decPart}`;
}

/** 账户卡片的年度收益展示结果；整行不展示时返回 null */
export interface YieldDisplay {
  /** 归属年份，如 `2025` */
  year: number;
  /** 收益金额（元），原始数值，供颜色判断用 */
  amount: number;
  /** `2025 年收益 ¥350.00` */
  fullText: string;
  /**
   * 收益是否好到该标语义色。
   * 项目约定（2026-10-06 主题还原后）：绿=好事红=坏事，positive→text-income=绿；
   * "当年亏损"（负数）是坏事 → 用中性色不抢注意力。
   */
  positive: boolean;
}

/**
 * 账户卡片上的年度收益展示口径。
 *
 * 返回 null（不展示）的三种情况：
 *   1. 负债账户（花呗等）：负债恒红 + "负债"角标，再挂一行"年收益"只会
 *      让人误以为欠款会产生利息；契约也明确要求负债账户不展示该字段。
 *   2. 没填过：latestYield 缺失 / 为 null。
 *   3. 金额不是有限数：容错 core 尚未上线或脏数据。
 *
 * 只展示"当年实际赚了多少"，**不做任何按余额的推算**——余额变的时刻和收益产生的
 * 时刻不是一回事，拿现余额乘一个旧百分比得到的数是假的。
 */
export function accountYieldDisplay(
  account: Pick<Account, 'type' | 'latestYield'>,
): YieldDisplay | null {
  if (isDebtType(account.type)) return null;
  const latest = account.latestYield;
  if (!latest || typeof latest.annualIncome !== 'number' || !Number.isFinite(latest.annualIncome)) {
    return null;
  }
  return {
    year: latest.year,
    amount: latest.annualIncome,
    fullText: `${latest.year} 年收益 ¥${formatAnnualIncome(latest.annualIncome)}`,
    positive: latest.annualIncome >= 0,
  };
}

/** 回填表单用：只回填"当前年"的值，往年记录不写进今年的输入框 */
export function yieldInputValue(
  latestYield: { year: number; annualIncome: number } | null | undefined,
  currentYear: number,
): string {
  if (!latestYield || latestYield.year !== currentYear) return '';
  if (!Number.isFinite(latestYield.annualIncome)) return '';
  return String(latestYield.annualIncome);
}
