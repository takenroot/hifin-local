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
  type: 'expense' | 'income';
  /** 商户/交易对方 */
  merchant: string;
  /** 备注（可选） */
  remark?: string;
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
}

export interface MailParser {
  /** 判断是否属于本解析器负责的邮件 */
  match(from: string, subject: string): boolean;
  /** 从邮件正文解析出交易列表 */
  parse(body: string): ParsedTx[];
}