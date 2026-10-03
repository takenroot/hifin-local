/**
 * 邮件账单解析器基础契约
 * 各家银行/支付平台的实现需提供：
 *   match() — 是否命中该来源
 *   parse() — 从正文抽取交易列表
 */

export interface ParsedTx {
  /** 交易时间戳（毫秒） */
  date: number;
  /** 金额（始终为正数，类型决定收支方向） */
  amount: number;
  /**
   * 收支方向 / 划转。
   *
   * 'transfer' 表示"钱从一个账户挪到另一个账户"，不改变净资产：
   * 解析层只给**账户名**（fromAccountName/toAccountName），落库时才按名
   * 解析成 accountId/toAccountId——解析层不该知道库里的 id。
   */
  type: 'expense' | 'income' | 'transfer';
  /** 商户/交易对方 */
  merchant: string;
  /** 备注（可选） */
  remark?: string;
  /**
   * 划转的转出账户**名**（仅 type='transfer' 时有值）。
   * 解析层不落 id：账单里只有"花呗""工商银行储蓄卡(1230)"这种渠道原文，
   * 账户 id 要由 importTransactions 在事务内按名查库解析。
   */
  fromAccountName?: string;
  /** 划转的转入账户名（仅 type='transfer' 时有值） */
  toAccountName?: string;
  /**
   * 平台账单自带的粗粒度分类原文：支付宝「交易分类」/ 微信「交易类型」。
   * 邮件账单解析器（cmb/alipay/wechat mail）拿不到这列，留空即可。
   */
  billCategory?: string;
  /**
   * 该笔流水来自哪个平台的**账单文件**（'alipay' / 'wechat'）。
   *
   * 刻意和 billCategory 分开两个字段：银行邮件账单里也可能带"交易类型"列，
   * 语义与微信完全不同。只有这里认得 'alipay'/'wechat' 时，
   * importTransactions 才会拿 billCategory 去查映射表，否则一律忽略。
   */
  platform?: string;
  /**
   * 溯源来源：'alipay' / 'wechat' / 'manual' / 'csv'。
   *
   * 与 platform 分开：platform 回答"这份账单是谁的"，只用来决定查哪张分类映射表；
   * source 回答"这一行从哪来"，会原样落库，并参与 (source, externalId) 精确去重。
   */
  source?: string;
  /**
   * 平台交易单号（微信「交易单号」/ 支付宝「交易订单号」）。
   *
   * 有它时去重走精确路径 (source, externalId)；没有才退回四字段启发式。
   * 启发式会把"同一天、同金额、同商户"的**两笔真实交易**误判成重复，有单号就不会。
   */
  externalId?: string;
  /** 支付方式主渠道原文（组合支付已取 & 前段）："零钱通" / "花呗" / "工商银行储蓄卡(1230)" */
  paymentMethod?: string;
  /** 交易状态原文："交易成功" / "退款成功" / "已全额退款" … */
  status?: string;
}

export interface MailParser {
  /** 判断是否属于本解析器负责的邮件 */
  match(from: string, subject: string): boolean;
  /** 从邮件正文解析出交易列表 */
  parse(body: string): ParsedTx[];
}