/**
 * 账单自带分类 → hifin 分类名 的映射
 * -----------------------------------------------------------------
 * 账单原件里平台自己给了粗粒度分类，只是导入时被丢掉了：
 *   - 支付宝 CSV 有「交易分类」列（交通出行 / 餐饮美食 / 投资理财 …）
 *   - 微信 xlsx 有「交易类型」列（商户消费 / 扫二维码付款 / 转账 …）
 *
 * 这层映射是"兜底"：它只在规则引擎（rules 表）没命中时生效，且只处理
 * **确定性高** 的映射。像微信的"商户消费""扫二维码付款"这种几乎不携带
 * 语义、必须靠商户名/备注才能判断的，一律返回 null 留给规则引擎，
 * 宁可留空也不猜错。
 *
 * 刻意不写死 categoryId：分类表的 id 随 seed 变化、也允许用户改名。
 * 这里只产出**分类名**，由调用方在库里按名字查（查不到就当没映射）。
 */

/** 本模块认识的账单平台；其它平台（如银行邮件账单）一律不映射 */
export type BillPlatform = 'alipay' | 'wechat';

/** 收支方向；与 transactions.type 的 expense/income 对齐 */
export type TxDirection = 'expense' | 'income';

/**
 * 映射结果里出现过的分类名 → 它在分类表里的 type。
 *
 * 用途是类型闸门：支出分类只能配支出流水、收入分类只能配收入流水。
 * 比如微信的「微信红包」既有收（收到的红包）又有支（发出的红包），
 * 映射到「人情往来」（支出类）后，收到红包那 24 笔就必须返回 null，
 * 否则会给一笔收入挂上支出分类，统计时凭空多出一笔支出。
 */
export const BILL_CATEGORY_TYPES: Readonly<Record<string, TxDirection>> = {
  日常餐饮: 'expense',
  公共交通: 'expense',
  服饰: 'expense',
  日用百货: 'expense',
  数码电器: 'expense',
  电影演出: 'expense',
  看病就医: 'expense',
  通讯话费: 'expense',
  美妆护肤: 'expense',
  人情往来: 'expense',
  其他支出: 'expense',
  其他收入: 'income',
};

/**
 * 支付宝「交易分类」→ 分类名。
 *
 * 覆盖账单里出现过的全部分类值（实测 18 个）。几个刻意保守的选择：
 *   - 投资理财 / 信用借还 → 其他支出：花呗还款、余额宝转入转出在支付宝口径里
 *     都是"不计收支"，根本进不了 transactions；真进来的零星几笔金额语义
 *     也不明确，笼统归到"其他支出"比猜成"投资收益"安全。
 *   - 文化休闲 → 电影演出：账单粒度只到"文化休闲"，电影演票/演出是其中最常见的
 *     一类，落到独立分类比全丢给"其他支出"有用。
 *   - 退款 / 收入 → 其他收入：能确定是进账，但账单不区分工资/奖金/投资收益。
 */
export const ALIPAY_BILL_CATEGORIES: Readonly<Record<string, string>> = {
  餐饮美食: '日常餐饮',
  交通出行: '公共交通',
  服饰装扮: '服饰',
  日用百货: '日用百货',
  数码电器: '数码电器',
  文化休闲: '电影演出',
  医疗健康: '看病就医',
  充值缴费: '通讯话费',
  美容美发: '美妆护肤',
  家居家装: '其他支出',
  生活服务: '其他支出',
  商业服务: '其他支出',
  爱车养车: '其他支出',
  投资理财: '其他支出',
  信用借还: '其他支出',
  其他: '其他支出',
  退款: '其他收入',
  收入: '其他收入',
};

/**
 * 微信「交易类型」→ 分类名。
 *
 * 微信这一列是"交易形态"而不是"消费场景"，语义弱得多，所以只收安全的：
 *   - 红包三类 → 人情往来（发出方向）
 *   - "xxx-退款" → 其他收入（进账）
 *   - 商户消费 / 扫二维码付款 / 转账 → null，必须靠商户名走规则引擎
 * 值为 null 表示"这一项刻意不映射"，与"键不存在"是两回事，一并留给规则引擎。
 *
 * 零钱通转入/转出不写进表：它们是账户内部划转，按理该进"不计收支"，
 * 实际账单里收/支列也是 "/"，解析阶段就被丢掉了，列在这里只为记录意图。
 */
export const WECHAT_BILL_CATEGORIES: Readonly<Record<string, string | null>> = {
  微信红包: '人情往来',
  '微信红包（单发）': '人情往来',
  '微信红包（群红包）': '人情往来',
  商户消费: null,
  扫二维码付款: null,
  转账: null,
};

/** 微信"零钱通转入/转出"前缀：账户内部划转，不映射 */
const WECHAT_TRANSFER_PREFIXES = ['转入零钱通', '零钱通转出'] as const;

/** 微信"…-退款"后缀（半角/全角连字符都收）：进账，映射为其他收入 */
const WECHAT_REFUND_RE = /[-－]退款$/;

/** 归一化：去首尾空白 + 去掉 Excel 导出常见的反引号包裹 */
function normalize(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw.trim().replace(/^`+|`+$/g, '').trim();
}

/**
 * 微信「交易类型」→ 分类名（不做收支类型闸门）。
 * 拆出来是为了让单测能直接钉住"字符串 → 分类名"这一层，
 * resolveBillCategory 再在其上叠收支类型闸门。
 */
export function resolveWechatBillCategory(billCategory: string): string | null {
  const v = normalize(billCategory);
  if (!v) return null;

  // 1) 账户内部划转最先排除：它不是收支，转账退款之类的名字也不该沾它
  if (WECHAT_TRANSFER_PREFIXES.some((p) => v.startsWith(p))) return null;

  // 2) 退款后缀优先于精确表：叫"微信红包-退款"的是退回来的红包，属于进账，
  //    不能因为前缀长得像红包就归到"人情往来"（支出类）上去
  if (WECHAT_REFUND_RE.test(v)) return '其他收入';

  // 3) 精确表（命中显式 null 也算命中，返回 null 交给规则引擎）
  if (Object.prototype.hasOwnProperty.call(WECHAT_BILL_CATEGORIES, v)) {
    return WECHAT_BILL_CATEGORIES[v] ?? null;
  }
  return null;
}

/** 支付宝「交易分类」→ 分类名（不做收支类型闸门） */
export function resolveAlipayBillCategory(billCategory: string): string | null {
  const v = normalize(billCategory);
  if (!v) return null;
  if (Object.prototype.hasOwnProperty.call(ALIPAY_BILL_CATEGORIES, v)) {
    return ALIPAY_BILL_CATEGORIES[v] ?? null;
  }
  return null;
}

/**
 * 账单自带分类 → hifin 分类名。
 *
 * @param platform      账单平台；非 alipay/wechat 一律返回 null
 *                      （银行邮件账单里也可能有"交易类型"列，语义完全不同，
 *                       不能拿去套微信的表）
 * @param billCategory  账单里的原始分类值（支付宝"交易分类"/微信"交易类型"）
 * @param txType        该笔流水的收支方向
 * @returns 分类名；无法安全判定（未知分类、刻意不映射、收支类型不匹配）时返回 null
 */
export function resolveBillCategory(
  platform: string | null | undefined,
  billCategory: string | null | undefined,
  txType: TxDirection,
): string | null {
  if (platform !== 'alipay' && platform !== 'wechat') return null;

  const name =
    platform === 'alipay' ? resolveAlipayBillCategory(billCategory ?? '') : resolveWechatBillCategory(billCategory ?? '');
  if (!name) return null;

  // 收支类型闸门：支出分类只配支出流水、收入分类只配收入流水
  const want = BILL_CATEGORY_TYPES[name];
  if (want !== txType) return null;
  return name;
}
