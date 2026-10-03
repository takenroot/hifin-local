/**
 * 账单支付渠道 → hifin 账户名 映射
 * =================================================================
 * 导入多账户前，每一笔账只能落到"导入时选的那一个账户"，于是支付宝的
 * 花呗、余额宝和工行卡支出全挤在一个账户里——资产分布图自然只有一根柱子。
 *
 * 账单本身其实带足了信息能分开它们：支付宝有「收/付款方式」列，微信有
 * 「支付方式」列，两者写的就是用户当时掏的是哪个渠道（"花呗&焕新折扣"里的
 * 前段即主支付渠道）。本模块把这串原文收敛成 7 个账户名之一。
 *
 * 设计上的三个要点：
 *   1. **只认名字，不认 id**：分类表的 id 会随 seed 变、账户也会被改名重建，
 *      所以这里产出账户**名**，由调用方拿它去库里查 id；查不到时回落到
 *      兜底账户「现金」并在结果里报告，绝不抛异常打断整批导入。
 *   2. **归并是业务决定，不是数据事实**：微信的「零钱」和「零钱通」在归并
 *      口径下是同一个账户，于是「转入零钱通-来自零钱」变成自转（见
 *      isSelfTransfer），这类行必须跳过，否则会给账户加一笔再减一笔。
 *   3. **组合支付取 & 前段**：与 app/src/features/transactions/csv.ts 的
 *      normalizePaymentMethod 同一口径，解析层已取过前段，这里再取一次是
 *      防"绕过解析层直连本函数"的调用方，两处口径必须一致。
 */

/** 本模块认识的账单平台；其它平台（如银行邮件账单）不参与渠道归并 */
export type BillPlatform = 'alipay' | 'wechat' | string;

/**
 * 账户名常量。
 *
 * 导出成常量而不是到处写字面量：账户列表页、导入结果报告、单测断言
 * 都得引用同一份拼写，改名时漏改一处就会静默归到「现金」。
 */
export const ACCOUNT_NAMES = {
  /** 微信零钱通 + 微信零钱（过渡渠道归并） */
  wechatInvest: '零钱通',
  /** 支付宝余额宝 + 支付宝账户余额（归并） */
  alipayInvest: '余额宝',
  /** 花呗（含花呗系组合支付），type=credit */
  huabei: '花呗',
  /** 工商银行储蓄卡(1230) */
  icbc: '工行卡(1230)',
  /** 中国银行储蓄卡(3544) */
  boc: '中行卡(3544)',
  /** 建设银行储蓄卡(9151) */
  ccb: '建行卡(9151)',
  /** 兜底：null / '/' / 未识别渠道 */
  fallback: '现金',
} as const;

/** 7 个账户名（顺序即账户列表页的展示顺序：资产在前、负债在后） */
export const ALL_ACCOUNT_NAMES: readonly string[] = [
  ACCOUNT_NAMES.wechatInvest,
  ACCOUNT_NAMES.alipayInvest,
  ACCOUNT_NAMES.icbc,
  ACCOUNT_NAMES.boc,
  ACCOUNT_NAMES.ccb,
  ACCOUNT_NAMES.huabei,
  ACCOUNT_NAMES.fallback,
];

/**
 * 账户名 → 账户类型。与 accounts.type 的取值对齐。
 *
 * 导出成一张表而不是让调用方各自 if：账户列表页要按 type 分组渲染
 * "资产/负债"两栏，导入链路要知道花呗是负债（余额应为负），
 * 两边对同一个账户的认知必须一致。
 */
export const ACCOUNT_TYPES: Readonly<Record<string, 'invest' | 'fund' | 'credit'>> = {
  [ACCOUNT_NAMES.wechatInvest]: 'invest',
  [ACCOUNT_NAMES.alipayInvest]: 'invest',
  [ACCOUNT_NAMES.icbc]: 'fund',
  [ACCOUNT_NAMES.boc]: 'fund',
  [ACCOUNT_NAMES.ccb]: 'fund',
  [ACCOUNT_NAMES.huabei]: 'credit',
  [ACCOUNT_NAMES.fallback]: 'fund',
};

/** 账户名 → 账户类型；表里没有的账户按「其它资产」处理，不当成负债 */
export function accountTypeOf(accountName: string): 'invest' | 'fund' | 'credit' {
  return ACCOUNT_TYPES[accountName] ?? 'fund';
}

/**
 * 支付渠道原文 → 账户名。
 *
 * 键刻意写成**归并后的规范名**，值即它归到哪个账户。这样"零钱"和"零钱通"
 * 在表里是两条独立记录、各自映射到「零钱通」，而不是先在某处归一再查表——
 * 归并口径就摆在这张表里，读表的人一眼能看见全部 7 个账户的来龙去脉。
 */
const CHANNEL_TO_ACCOUNT: Readonly<Record<string, string>> = {
  // ── 零钱通（微信）：零钱是它的过渡渠道，归并 ──
  零钱通: ACCOUNT_NAMES.wechatInvest,
  零钱: ACCOUNT_NAMES.wechatInvest,

  // ── 余额宝（支付宝）：账户余额（充值/提现走的那个）也归并进来 ──
  余额宝: ACCOUNT_NAMES.alipayInvest,
  账户余额: ACCOUNT_NAMES.alipayInvest,

  // ── 花呗（负债）──
  花呗: ACCOUNT_NAMES.huabei,

  // ── 银行卡（尾号在渠道名里，必须带上才认得出是哪张卡）──
  // 键里有括号，不是合法标识符，必须加引号
  '工商银行储蓄卡(1230)': ACCOUNT_NAMES.icbc,
  '中国银行储蓄卡(3544)': ACCOUNT_NAMES.boc,
  '建设银行储蓄卡(9151)': ACCOUNT_NAMES.ccb,
};

/**
 * 微信「交易类型」里零钱通划转的前缀。
 *
 * 抽成常量导出，是为了让「谁能自转」的判断只此一处：
 * 转出方恒为「零钱通」，所以只有"来自零钱"这一支会自转（来自银行卡的不会）。
 */
export const WECHAT_TRANSFER_IN_PREFIX = '转入零钱通-来自';
export const WECHAT_TRANSFER_OUT_PREFIX = '零钱通转出-到';

/** 归一化：去首尾空白 + 去掉 Excel 导出常见的反引号/单引号包裹 */
function normalize(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^[`'"“”]+/, '')
    .replace(/[`'"“”]+$/, '')
    .trim();
}

/**
 * 支付渠道 → 账户名。
 *
 * @param paymentMethod 账单「收/付款方式」/「支付方式」原文。
 *                      组合支付（"花呗&焕新折扣"）自动取 & 前段。
 * @param platform      账单平台。仅用于"同名的渠道在不同平台含义不同"的
 *                      兜底判断；目前两家平台没有撞名的渠道（"账户余额"
 *                      只有支付宝有），所以它不影响归并结果，但保留参数
 *                      是为了将来出现同名渠道时不必改所有调用方。
 * @returns 7 个账户名之一。空值/'/' 占位符/未识别渠道一律返回「现金」。
 *
 * 未识别的渠道（如实测里出现的"内蒙古农信储蓄卡(6322)"）归到「现金」
 * 而不是 null：导入链路要的是一个能落库的账户名，让调用方自己处理
 * "null 怎么办"只会让每个调用方各写一套、且迟早漏一处。
 */
export function resolveAccountName(
  paymentMethod: string | null | undefined,
  platform?: BillPlatform,
): string {
  void platform; // 保留参数位：当前口径下无需按平台分流，见上方说明
  const v = normalize(paymentMethod);
  // 组合支付取 & 前段的主渠道。与 app csv.ts 的 normalizePaymentMethod 同口径：
  // "工商银行储蓄卡(1230)&工商银行立减金" 的主支付渠道是银行卡，不是立减金。
  const main = (v.split('&')[0] ?? '').trim();
  if (!main) return ACCOUNT_NAMES.fallback;

  const hit = CHANNEL_TO_ACCOUNT[main];
  if (hit) return hit;

  /**
   * 带尾号的银行卡容错：渠道名里的尾号可能带空格（"工商银行储蓄卡( 1230)"），
   * 或被账单换成了全角括号。这些仍是同一张卡，不该因为一个空格就掉进「现金」。
   * 这里只做"去掉所有空白与括号内空白"的宽松匹配，不做模糊猜测——
   * 认不出的卡一律进「现金」，宁可让用户手工调，也不猜错到别的账户上。
   */
  const loose = main.replace(/\s+/g, '');
  for (const [channel, account] of Object.entries(CHANNEL_TO_ACCOUNT)) {
    if (channel.replace(/\s+/g, '') === loose) return account;
  }

  return ACCOUNT_NAMES.fallback;
}

/** 一次划转的两端（账户**名**；解析层不碰 id） */
export interface TransferLegs {
  fromAccountName: string;
  toAccountName: string;
}

/**
 * 微信「交易类型」→ 零钱通划转的两端；不是划转返回 null。
 *
 * 两种句式（实测 27 行全部落在这两种里）：
 *   "转入零钱通-来自工商银行(1230)"  →  工商银行储蓄卡(1230) → 零钱通
 *   "零钱通转出-到工商银行(1230)"    →  零钱通 → 工商银行储蓄卡(1230)
 *
 * 句式里的"工商银行(1230)"是**简称**，不是「收/付款方式」列的规范名
 * "工商银行储蓄卡(1230)"；两者只差"储蓄卡"三个字，所以先补全再交给
 * resolveAccountName 查表，而不是为简称另写一张表——多一张表就多一处
 * 会和主表漂移的可能。
 */
export function parseWechatTransfer(billCategory: string | null | undefined): TransferLegs | null {
  const v = normalize(billCategory);
  if (v.startsWith(WECHAT_TRANSFER_IN_PREFIX)) {
    const from = resolveAccountName(expandBankShortName(v.slice(WECHAT_TRANSFER_IN_PREFIX.length)), 'wechat');
    return { fromAccountName: from, toAccountName: ACCOUNT_NAMES.wechatInvest };
  }
  if (v.startsWith(WECHAT_TRANSFER_OUT_PREFIX)) {
    const to = resolveAccountName(expandBankShortName(v.slice(WECHAT_TRANSFER_OUT_PREFIX.length)), 'wechat');
    return { fromAccountName: ACCOUNT_NAMES.wechatInvest, toAccountName: to };
  }
  return null;
}

/** 支付宝「交易状态」里代表"这笔确实动了钱"的成功态 */
const ALIPAY_REPAY_OK = '还款成功';

/** 支付宝还款行里，代表"这笔不是真消费"的其它状态，一律丢弃 */
const ALIPAY_NON_MONEY_STATUS = [
  '还款失败',
  '交易关闭',
  '解冻成功',
  '免押',
  '退款成功',
] as const;

/**
 * 支付宝信用借还行 → 花呗还款划转的一端；不是还款成功返回 null。
 *
 * 判据是「交易状态=还款成功」**且** 对方/分类里出现花呗或信用：
 * 还款成功专指花呗/信用卡还款，而"信用借还"这一分类下还混着
 * 押金解冻、免押下单这类 0 元凭证（实测各 10 行），它们状态不同、
 * 金额为 0，两道判据一起把误判挡在外面。
 *
 * toAccountName 恒为「花呗」：还款就是还花呗，不存在还到别处。
 * fromAccountName 取「收/付款方式」实测有值（工行卡/余额宝/农信卡），
 * 少数行是空的，空的按兜底归「现金」，与 resolveAccountName 的口径一致。
 */
export function parseAlipayRepayTransfer(
  status: string | null | undefined,
  merchant: string | null | undefined,
  billCategory: string | null | undefined,
  paymentMethod: string | null | undefined,
): TransferLegs | null {
  if (normalize(status) !== ALIPAY_REPAY_OK) return null;
  const hint = `${normalize(merchant)} ${normalize(billCategory)}`;
  if (!hint.includes('花呗') && !hint.includes('信用')) return null;
  return {
    fromAccountName: resolveAccountName(paymentMethod, 'alipay'),
    toAccountName: ACCOUNT_NAMES.huabei,
  };
}

/** 这一行是不是"从 A 划到 A"的自转（归并后两边同名） */
export function isSelfTransfer(legs: TransferLegs): boolean {
  return legs.fromAccountName === legs.toAccountName;
}

/**
 * 划转状态白名单：非空且不含下列关键字时才算"这笔钱真的动了"。
 * 微信"零钱通转出"到银行卡时状态是「资金已到账」，导入时按已到账记账。
 */
export function isEffectiveTransferStatus(status: string | null | undefined): boolean {
  const v = normalize(status);
  if (!v) return true; // 账单没这列时不做拦截，交给金额等其它判据
  for (const bad of ['失败', '已关闭', '取消', '关闭', '退款']) {
    if (v.includes(bad)) return false;
  }
  return true;
}

/** 支付宝非资金态状态表，供单测/报告断言"这些行确实被丢弃了" */
export function isAlipayNonMoneyStatus(status: string | null | undefined): boolean {
  const v = normalize(status);
  return ALIPAY_NON_MONEY_STATUS.some((s) => v.includes(s));
}

/**
 * 银行卡简称补全："工商银行(1230)" → "工商银行储蓄卡(1230)"。
 *
 * 只补"储蓄卡"这三个字，不做更宽的猜测：账单里这批简称的银行名与规范名
 * 只差这一处，补全后即可命中 CHANNEL_TO_ACCOUNT；认不出的（"某某银行(1234)"）
 * 补了也补不中，最终自然落到「现金」。
 *
 * 导出是因为它就是一条可独立验证的规则：单测直接钉住"简称→规范名"，
 * 比绕道 parseWechatTransfer 再反推两端更能把这条规则的边界说清楚。
 */
export function expandBankShortName(raw: string): string {
  const v = normalize(raw);
  if (!v) return v;
  if (v.includes('储蓄卡')) return v;
  const m = v.match(/^(.+?)\s*[（(]\s*(\d{3,6})\s*[）)]$/);
  if (m) return `${m[1]}储蓄卡(${m[2]})`;
  return v;
}
