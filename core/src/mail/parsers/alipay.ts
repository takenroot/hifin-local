/**
 * 支付宝账单邮件解析器
 * 匹配规则：发件人包含 alipay 或 主题包含 "账单"
 * 文本格式样例：
 *   2024-05-12 10:23 支出 35.50 元  星巴克  余额 ¥123.45
 *   2024-05-13 09:00 收入 100.00 元  退款  余额 ¥0.00
 */

import type { MailParser, ParsedTx } from './base.js';

const RE = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2})\s+(支出|收入)\s+([\d,]+(?:\.\d+)?)\s*元?\s+(.+?)\s*(?:余额|$)/g;

function toTs(s: string): number {
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (!m) return Date.now();
  const [, y, mo, d, hh, mm] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
  ).getTime();
}

export class AlipayParser implements MailParser {
  match(from: string, subject: string): boolean {
    const f = (from || '').toLowerCase();
    const s = subject || '';
    return f.includes('alipay') || s.includes('账单');
  }

  parse(body: string): ParsedTx[] {
    const out: ParsedTx[] = [];
    if (!body) return out;
    RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(body)) !== null) {
      const [, dateStr, dir, amountStr, merchantRaw] = m;
      const amount = Number(amountStr.replace(/,/g, ''));
      if (!isFinite(amount) || amount <= 0) continue;
      const merchant = merchantRaw.trim().replace(/\s+/g, ' ');
      out.push({
        date: toTs(dateStr),
        amount,
        type: dir === '收入' ? 'income' : 'expense',
        merchant: merchant || '支付宝',
        remark: '支付宝账单',
      });
    }
    return out;
  }
}