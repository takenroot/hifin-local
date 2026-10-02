/**
 * 微信支付账单邮件解析器
 * 匹配规则：发件人包含 wechat 或 主题包含 "微信支付账单"
 * 文本格式样例：
 *   2024-05-12 10:23:45 支付 ¥35.50 给商户 星巴克咖啡
 *   2024-05-13 09:00:12 收款 ¥280.00 来自 张三
 */

import type { MailParser, ParsedTx } from './base.js';

const RE = /(\d{4}[-/]\d{1,2}[-/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s+(支付|收款)\s*[¥￥]?\s*([\d,]+(?:\.\d+)?)\s*(?:给商户|来自)\s*(.+)/g;

function toTs(s: string): number {
  // 兼容 10:23 与 10:23:45
  const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return Date.now();
  const [, y, mo, d, hh, mm, ss] = m;
  return new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(hh),
    Number(mm),
    ss ? Number(ss) : 0,
  ).getTime();
}

export class WechatParser implements MailParser {
  match(from: string, subject: string): boolean {
    const f = (from || '').toLowerCase();
    const s = subject || '';
    return f.includes('wechat') || s.includes('微信支付账单');
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
        type: dir === '收款' ? 'income' : 'expense',
        merchant: merchant || '微信支付',
        remark: '微信支付账单',
      });
    }
    return out;
  }
}