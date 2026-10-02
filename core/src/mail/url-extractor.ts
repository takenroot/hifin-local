/**
 * 微信支付账单邮件的「立即下载」URL 提取器。
 *
 * 背景（见 docs/bill-automation-design.md）：微信账单邮件没有附件，只在 HTML 正文里
 * 放一个「立即下载」超链接，所以必须自己把链接抠出来再交给下载器。
 *
 * 微信 HTML 里的链接有三种常见形态，都做了处理：
 *   1. 直链：      href="https://dldir1v6.qq.com/xxx.zip?key=abc"
 *   2. 跳转中转：  href="https://weixin110.qq.com/cgi-bin/.../newredirectconfirmcgi?...&url=https%3A%2F%2Fxxx"
 *                  → 需要把 url= 参数里的真实地址解出来
 *   3. 相对路径：  href="/cgi-bin/download?id=1" 或 href="download?id=1"
 *                  → 用 baseUrl 拼成完整 URL（默认微信账单域）
 *
 * 提取不到（没有「立即下载」链接、href 为空、是 javascript:/mailto: 之类的伪协议）
 * 一律返回 null，由调用方决定降级策略。
 */

/** 相对链接兜底域名：微信账单/客服跳转都挂在 weixin110.qq.com 下 */
export const DEFAULT_WECHAT_BILL_BASE = 'https://weixin110.qq.com';

/** 按钮文案关键词：命中任意一个即认为是账单下载入口 */
const BUTTON_TEXTS = ['立即下载', '下载账单', '账单下载', '下载对账单', '点击下载'];

/** 伪协议：抠出来也不能用，直接判为提取失败 */
const BOGUS_SCHEME_RE = /^\s*(javascript|mailto|tel|sms|data|about|file)\s*:/i;

/** href 中可能藏着真实直链的跳转参数名（小写比较） */
const REDIRECT_PARAMS = ['url', 'target', 'redirect', 'redirecturl', 'goto', 'link', 'to'];

/** 解 HTML 实体：&amp; &#38; &#x26; &quot; 等。账单链接里 &amp; 极常见，不解会 403 */
function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeFromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeFromCharCode(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

function safeFromCharCode(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return '';
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 去掉标签、实体和多余空白，得到按钮可见文案（<a ...><span>立即下载</span></a> 也能命中） */
function anchorText(inner: string): string {
  return decodeEntities(inner.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, '')
    .trim();
}

/** href 可能被 HTML 换行/缩进折断，先把内部空白（含换行）压掉 */
function normalizeHref(href: string): string {
  return decodeEntities(href).replace(/\s+/g, '').trim();
}

/** 从中转页 URL 的查询参数里再挖一层真实直链 */
function unwrapRedirect(url: string): string {
  const queryIdx = url.indexOf('?');
  if (queryIdx < 0) return url;
  const query = url.slice(queryIdx + 1);
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = decodeEntities(part.slice(0, eq)).trim().toLowerCase();
    if (!REDIRECT_PARAMS.includes(key)) continue;
    const raw = part.slice(eq + 1);
    let value = raw;
    try {
      // 中转参数常见二次编码（%253A → %3A），多解一次
      value = decodeURIComponent(decodeURIComponent(raw));
    } catch {
      try {
        value = decodeURIComponent(raw);
      } catch {
        value = raw;
      }
    }
    value = normalizeHref(value);
    if (/^https?:\/\//i.test(value)) return value;
  }
  return url;
}

/** 相对路径 / 协议相对链接 → 拼成完整 URL */
function toAbsolute(href: string, baseUrl: string): string | null {
  if (!href) return null;
  if (BOGUS_SCHEME_RE.test(href)) return null;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(href)) return href;
  // //host/path → 沿用 https
  if (href.startsWith('//')) return `https:${href}`;

  let base = baseUrl || DEFAULT_WECHAT_BILL_BASE;
  if (!/^https?:\/\//i.test(base)) base = DEFAULT_WECHAT_BILL_BASE;

  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/**
 * 从微信账单邮件 HTML 中提取账单下载链接。
 *
 * @param html     邮件正文 HTML（完整页面或正文片段均可）
 * @param baseUrl  相对路径的兜底域名，默认 https://weixin110.qq.com
 * @returns 完整下载 URL；提取不到返回 null
 */
export function extractWechatDownloadUrl(
  html: string,
  baseUrl: string = DEFAULT_WECHAT_BILL_BASE,
): string | null {
  if (!html || typeof html !== 'string') return null;

  // 逐个扫 <a ...>…</a>，先按按钮文案命中；微信邮件里 href 里可能带 > ，
  // 因此用「下一个 </a>」作为边界，不做嵌套解析。
  const anchors: Array<{ href: string; inner: string }> = [];
  const anchorRe = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const hrefMatch = attrs.match(/\bhref\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'`]+))/i);
    if (!hrefMatch) continue;
    const href = normalizeHref(hrefMatch[2] ?? hrefMatch[3] ?? hrefMatch[4] ?? '');
    if (!href) continue;
    anchors.push({ href, inner });
  }

  if (anchors.length === 0) return null;

  // 1) 优先：按钮文案命中「立即下载」等关键词
  for (const a of anchors) {
    const text = anchorText(a.inner);
    // 图片按钮：文案可能在 alt/title 上
    const altText = anchorText(
      (a.inner.match(/\b(?:alt|title)\s*=\s*("[^"]*"|'[^']*')/gi) ?? []).join(' '),
    );
    if (BUTTON_TEXTS.some((kw) => text.includes(kw) || altText.includes(kw))) {
      const resolved = toAbsolute(unwrapRedirect(a.href), baseUrl);
      if (resolved) return resolved;
    }
  }

  // 2) 兜底：没有按钮文案时，找一个 href 本身就像账单下载地址的链接
  for (const a of anchors) {
    const resolved = toAbsolute(unwrapRedirect(a.href), baseUrl);
    if (!resolved) continue;
    if (/(?:download|getbill|bill|export)/i.test(resolved)) return resolved;
  }

  return null;
}
