/**
 * 邮件解析器注册表
 * 提供 PARSERS 列表与 detectParser() 自动匹配
 */

import type { MailParser } from './base.js';
import { AlipayParser } from './alipay.js';
import { WechatParser } from './wechat.js';
import { CmbParser } from './cmb.js';

export const PARSERS: MailParser[] = [
  new AlipayParser(),
  new WechatParser(),
  new CmbParser(),
];

export function detectParser(from: string, subject: string): MailParser | null {
  for (const p of PARSERS) {
    if (p.match(from, subject)) return p;
  }
  return null;
}

export type { MailParser, ParsedTx } from './base.js';
export { AlipayParser } from './alipay.js';
export { WechatParser } from './wechat.js';
export { CmbParser } from './cmb.js';