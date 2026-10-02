/**
 * 招商银行账单邮件解析器
 * 匹配规则：发件人包含 cmbchina 或 主题包含 "招商银行"
 * 文本格式样例：
 *   2024-05-12 支出 35.50 余额 1234.56 星巴克(支付宝)
 *   2024-05-13 收入 5000.00 余额 6234.56 工资
 */

import type { MailParser, ParsedTx } from './base.js';

const RE = /(\d{4}[-/]\d{1,2}[-/]\d{1,2})\s+(支出|收入)\s+([\d,]+(?:\.\d+)?)\s+余额\s+[\d,]+(?:\.\d+)?\s+(.+)/g;

function toTs(s: string): number {
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (!m) return Date.now();
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0).getTime();
}

export class CmbParser implements MailParser {
  match(from: string, subject: string): boolean {
    const f = (from || '').toLowerCase();
    const s = subject || '';
    return f.includes('cmbchina') || s.includes('招商银行');
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
        merchant: merchant || '招商银行',
        remark: '招商银行账单',
      });
    }
    return out;
  }
}