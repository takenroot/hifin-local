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
}

export interface MailParser {
  /** 判断是否属于本解析器负责的邮件 */
  match(from: string, subject: string): boolean;
  /** 从邮件正文解析出交易列表 */
  parse(body: string): ParsedTx[];
}