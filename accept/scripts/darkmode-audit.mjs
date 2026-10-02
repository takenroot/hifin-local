/**
 * 暗黑模式全面视觉审计（只读，不改任何业务代码）
 * ---------------------------------------------------------------
 * 用法：node accept/scripts/darkmode-audit.mjs   （需先起 core :8787 + vite :5199）
 *
 * 目标：用 Playwright 强制暗黑模式，系统性扫描 9 个页面 + 8 个 Modal 的
 *       文字 / placeholder / 边框 / 图标 对比度，输出结构化问题清单。
 *
 * 判定口径（写入 issues.json 的 meta.thresholds，便于复核时对齐）：
 *   - 文字 / placeholder / 图标：对比度 < 3.0 记为 issue（"不可见"），< 4.5 记为 advisory
 *   - 边框（WCAG 1.4.11 非文本对比）：< 1.5 记为 issue（"边框太淡"），< 3.0 记为 advisory
 *   - 对比度公式：(L1 + 0.05) / (L2 + 0.05)，L = 0.2126R + 0.7152G + 0.0722B（sRGB→linear）
 *   - 背景色：向上遍历祖先链合成 effective background（遇不透明层即停，再向下逐层 alpha 合成）
 *
 * 已知取舍（同样写进 meta，便于解释为什么某些元素没进 issues）：
 *   - computed opacity === 0 的元素记入 hiddenByOpacity（hover 才显形的操作按钮），
 *     不算 issue——那是交互设计，不是配色缺陷。
 *   - 扫描整个 DOM（不限首屏视口），对比度与滚动位置无关；截图才用 fullPage:false。
 */

import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.HIFIN_BASE || 'http://127.0.0.1:5199';
const OUT_DIR = '/home/saltedfish/project/hifin/accept/darkmode-audit';
const VIEWPORT = { width: 1440, height: 900 };

/* ── 阈值 ─────────────────────────────────────────────────────── */
const TH = {
  textIssue: 3.0, // 文字/placeholder/图标：低于此值 = 不可见
  textWarn: 4.5, // 低于此值 = 偏淡（WCAG AA 正文），仅作 advisory
  borderIssue: 1.5, // 边框低于此值 = 边框太淡
  borderWarn: 3.0, // 边框低于此值 = 达不到 1.4.11 的 3:1
};

/* ── 待审计页面 ─────────────────────────────────────────────────── */
const PAGES = [
  { name: 'home', route: '/home' },
  { name: 'account-list', route: '/account/list' },
  { name: 'transaction', route: '/transaction' },
  { name: 'goal-list', route: '/goal/list' },
  { name: 'report-list', route: '/report/list' },
  { name: 'budget', route: '/budget' },
  { name: 'discover', route: '/discover' },
  { name: 'settings', route: '/settings' },
  { name: 'ai', route: '/ai' },
];

/* ── 通用 Modal 卡片选择器（src/components/ui/Modal.tsx 的固定结构） ── */
const MODAL_SCOPE = '.fixed.inset-0.z-50 > div.relative';

/* ── 待审计 Modal ───────────────────────────────────────────────── */
const MODALS = [
  {
    name: 'transaction-create',
    route: '/transaction?create=1',
    note: 'URL ?create=1 自动打开新建流水',
  },
  {
    name: 'transaction-edit',
    route: '/transaction',
    open: async (page) => {
      await page.locator('[title="编辑"]').first().click({ timeout: 10000 });
      return '点击流水行 hover 后的「编辑」按钮';
    },
    note: '编辑已有流水（覆盖已填值 + 非法态校验文案）',
  },
  {
    name: 'account-create-step1',
    route: '/account/list?create=1',
    note: '新建账户第 1 步：选择账户类型',
  },
  {
    name: 'account-create-step2',
    route: '/account/list?create=1',
    open: async (page) => {
      // 「下一步」在未选类型时是 disabled，必须先选一个账户类型
      const typeBtn = page.locator('.fixed.inset-0.z-50 button.w-full.flex.items-start').first();
      if ((await typeBtn.count()) === 0) return null;
      await typeBtn.click({ timeout: 8000 });
      const next = page.getByRole('button', { name: '下一步' });
      if ((await next.count()) === 0) return null;
      await next.first().click({ timeout: 8000 });
      return '先选账户类型，再点「下一步」进入表单';
    },
    note: '新建账户第 2 步：表单（label / placeholder / 辅助说明最密集）',
  },
  {
    name: 'goal-create',
    route: '/goal/list?create=1',
    note: '新建目标',
  },
  {
    name: 'budget-create',
    route: '/budget?create=1',
    note: '新建预算',
  },
  {
    name: 'report-create',
    route: '/report/list',
    open: async (page) => {
      await page.getByRole('button', { name: '新建报表' }).first().click({ timeout: 10000 });
      return '点击「新建报表」按钮';
    },
    note: '新建报表（无 ?create=1，只能点按钮）',
  },
  {
    name: 'command-palette',
    route: '/home',
    // 命令面板不是通用 Modal：CommandPaletteView 用 fixed + role="dialog"，
    // 没有 .fixed.inset-0.z-50 > div.relative 这层结构，scope 必须单独指定
    scope: '[role="dialog"]',
    open: async (page) => {
      await page.keyboard.press('Control+KeyK');
      return '按下 Ctrl+K（⌘K 等价快捷键）';
    },
    note: '命令面板，含搜索框 placeholder + 快捷键提示',
  },
  {
    name: 'city-switch',
    route: '/home',
    open: async (page) => {
      await page.locator('[title="切换城市"]').first().click({ timeout: 10000 });
      return '点击看板天气区「切换城市」图标按钮';
    },
    note: '天气城市切换，含城市搜索框 placeholder + 空态文案',
  },
];

/* ═══════════════════════════════════════════════════════════════
 * 页面内扫描器（在浏览器上下文执行，必须自包含）
 * ═══════════════════════════════════════════════════════════════ */
function scanInPage({ scope }) {
  const res = {
    scope: scope || 'body',
    found: false,
    text: [],
    placeholder: [],
    border: [],
    icon: [],
    hiddenByOpacity: [],
    intentionallyTransparent: [],
    unparsed: [],
    notes: [],
  };

  const root = scope ? document.querySelector(scope) : document.body;
  if (!root) {
    res.notes.push(`未找到 scope: ${scope}`);
    return res;
  }
  res.found = true;

  /* 颜色解析：1x1 canvas 像素采样。
     好处是任何浏览器能渲染的颜色写法（rgb/rgba/hsl/oklch/color()…）都能归一化成 rgba，
     解析不了的记入 unparsed，绝不静默丢弃。 */
  const cv = document.createElement('canvas');
  cv.width = 1;
  cv.height = 1;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const SENTINEL = '#010203'; // 用来识别「fillStyle 赋值失败」
  const colorCache = new Map();

  function parseColor(str) {
    if (!str) return null;
    if (colorCache.has(str)) return colorCache.get(str);
    let out = null;
    if (str === 'transparent' || str === 'none') {
      out = { r: 0, g: 0, b: 0, a: 0 };
      colorCache.set(str, out);
      return out;
    }
    try {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = SENTINEL;
      ctx.fillStyle = str; // 解析成功则变成归一化值，失败则保持 SENTINEL
      const applied = String(ctx.fillStyle).toLowerCase();
      if (applied !== SENTINEL) {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = str;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        out = { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
      }
    } catch {
      out = null;
    }
    if (!out) res.unparsed.push(str);
    colorCache.set(str, out);
    return out;
  }

  /* sRGB → linear → 相对亮度 */
  const lin = (c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => {
    const l1 = lum(a);
    const l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  /** 把带 alpha 的前景合成到不透明背景上 */
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const css = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  const round2 = (n) => Math.round(n * 100) / 100;

  /** 向上遍历祖先链求 effective background。
      命中最外层不透明层作为底，再从外向内逐层 alpha 合成（等价于 CSS 实际绘制顺序）。 */
  function effectiveBackground(el) {
    const layers = [];
    let hasImage = false;
    let node = el;
    while (node && node.nodeType === 1) {
      const cs = getComputedStyle(node);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') hasImage = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        layers.push(c);
        if (c.a >= 0.999) break; // 找到不透明底，停止向上
      }
      node = node.parentElement;
    }
    let acc = { r: 255, g: 255, b: 255, a: 1 }; // 极端兜底：白
    for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc);
    return { bg: acc, hasImage, depth: layers.length };
  }

  /** 稳定的选择器：优先 data-testid / id，其次 tag + class + nth-of-type */
  function cssPath(el) {
    const tid = el.getAttribute && el.getAttribute('data-testid');
    if (tid) return `[data-testid="${tid}"]`;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 5) {
      let seg = node.tagName.toLowerCase();
      if (typeof node.className === 'string' && node.className.trim()) {
        const cls = node.className
          .trim()
          .split(/\s+/)
          .filter((c) => c && !/^(dark|group|hover|focus|active|peer)$/.test(c))
          .slice(0, 3);
        if (cls.length) seg += cls.map((c) => `.${CSS.escape(c)}`).join('');
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) seg += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(seg);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** 只取元素「自己」持有的直接文本节点，避免父子重复计数 */
  function ownText(el) {
    let s = '';
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue || '';
    return s.replace(/\s+/g, ' ').trim();
  }

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BR', 'WBR']);

  function isRendered(el) {
    if (SKIP_TAGS.has(el.tagName)) return false;
    if (el.closest && el.closest('[aria-hidden="true"]')) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return false;
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 是否处于禁用态（自身或祖先 form 控件） */
  function isDisabled(el) {
    let n = el;
    while (n && n.nodeType === 1 && n !== document.documentElement) {
      if (n.disabled === true) return true;
      if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
      n = n.parentElement;
    }
    return false;
  }

  function classifyText(el, text, isPlaceholder) {
    if (isPlaceholder) return 'placeholder不可见';
    const cls = typeof el.className === 'string' ? el.className : '';
    if (el.tagName === 'LABEL' || (el.closest && el.closest('label'))) return 'label不可见';
    if (/(^|[\s-])(field-)?label([\s-]|$)/i.test(cls)) return 'label不可见';
    if (isDisabled(el)) return '禁用状态不可见';
    if (el.tagName === 'SMALL' || /hint|help|desc|subtitle|note|muted|辅助|说明/i.test(cls)) {
      return '辅助文字不可见';
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
      return '按钮文字不可见';
    }
    return '其他文本不可见';
  }

  const all = [root, ...root.querySelectorAll('*')];

  /* ── 1. 文字元素 ─────────────────────────────────────────────── */
  for (const el of all) {
    if (el.nodeType !== 1) continue;
    if (!isRendered(el)) continue;
    const cs = getComputedStyle(el);
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) {
      const t = ownText(el);
      if (t) {
        res.hiddenByOpacity.push({ selector: cssPath(el), text: t.slice(0, 40) });
      }
      continue; // 完全透明 = hover 才显形，不算配色缺陷
    }

    const texts = [];
    const own = ownText(el);
    if (own) texts.push({ text: own, pseudo: null });
    // ::before / ::after 生成的文字同样是「用户要读的内容」
    for (const pe of ['::before', '::after']) {
      const pcs = getComputedStyle(el, pe);
      if (!pcs) continue;
      const content = (pcs.content || '').replace(/^["']|["']$/g, '').trim();
      if (content && content !== 'none' && !/^attr\(|^url\(/.test(content)) {
        texts.push({ text: content, pseudo: pe });
      }
    }
    if (texts.length === 0) continue;

    const { bg, hasImage, depth } = effectiveBackground(el);
    const rawColor = parseColor(cs.color);
    if (!rawColor) continue;
    // text-transparent 等「故意把文字设成全透明」的占位元素不是配色缺陷，
    // 归入 intentionallyTransparent 单独记账，避免刷屏
    if (rawColor.a === 0) {
      res.intentionallyTransparent.push({ selector: cssPath(el), text: ownText(el).slice(0, 40) });
      continue;
    }

    for (const { text, pseudo } of texts) {
      // 伪元素继承父级 color，但用自己的 ::before/::after color
      const colorRaw = pseudo ? parseColor(getComputedStyle(el, pseudo).color) : rawColor;
      if (!colorRaw) continue;
      // opacity 也会作用在伪元素上
      const peOpacity = pseudo ? parseFloat(getComputedStyle(el, pseudo).opacity) || 1 : 1;
      const fg = over({ ...colorRaw, a: colorRaw.a * opacity * peOpacity }, bg);
      const fontSize = parseFloat(cs.fontSize) || 0;
      const fontWeight = parseInt(cs.fontWeight, 10) || 400;
      res.text.push({
        selector: cssPath(el),
        tag: el.tagName.toLowerCase(),
        text: text.slice(0, 60),
        pseudo,
        color: css(fg),
        colorRaw: cs.color,
        background: css(bg),
        contrast: round2(contrast(fg, bg)),
        fontSize,
        fontWeight,
        largeText: fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700),
        opacity: round2(opacity),
        disabled: isDisabled(el),
        className: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
        category: classifyText(el, text, false),
        bgHasImage: hasImage,
        bgDepth: depth,
      });
    }
  }

  /* ── 2. placeholder（伪元素无法用 querySelector 命中，单独遍历） ── */
  for (const inp of root.querySelectorAll('input[placeholder], textarea[placeholder]')) {
    if (!isRendered(inp)) continue;
    if (inp.value) continue; // 有值时 placeholder 不渲染
    const cs = getComputedStyle(inp);
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) continue;
    const pcs = getComputedStyle(inp, '::placeholder');
    if (!pcs) continue;
    const raw = parseColor(pcs.color);
    if (!raw) continue;
    const { bg, hasImage } = effectiveBackground(inp);
    const fg = over({ ...raw, a: raw.a * opacity }, bg);
    const fontSize = parseFloat(cs.fontSize) || 0;
    const fontWeight = parseInt(cs.fontWeight, 10) || 400;
    res.placeholder.push({
      selector: cssPath(inp),
      tag: inp.tagName.toLowerCase(),
      text: inp.getAttribute('placeholder') || '',
      color: css(fg),
      colorRaw: pcs.color,
      background: css(bg),
      contrast: round2(contrast(fg, bg)),
      fontSize,
      fontWeight,
      largeText: fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700),
      opacity: round2(opacity),
      disabled: isDisabled(inp),
      className: (inp.className || '').slice(0, 120),
      category: 'placeholder不可见',
      bgHasImage: hasImage,
    });
  }

  /* ── 3. 边框（CSS 默认 background-clip: border-box，
        所以边框画在「元素自身背景」之上，底色用自身 effective background） ── */
  for (const el of all) {
    if (el.nodeType !== 1) continue;
    if (!isRendered(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const sides = [
      ['top', cs.borderTopWidth, cs.borderTopColor],
      ['right', cs.borderRightWidth, cs.borderRightColor],
      ['bottom', cs.borderBottomWidth, cs.borderBottomColor],
      ['left', cs.borderLeftWidth, cs.borderLeftColor],
    ];
    const visible = sides.filter(([, w]) => (parseFloat(w) || 0) > 0);
    if (visible.length === 0) continue;

    const { bg } = effectiveBackground(el);
    for (const [side, w, colorStr] of visible) {
      const raw = parseColor(colorStr);
      if (!raw || raw.a === 0) continue; // transparent 边框 = 没有边框
      const composite = over(raw, bg);
      res.border.push({
        selector: cssPath(el),
        side,
        widthPx: parseFloat(w) || 0,
        color: css(composite),
        colorRaw: colorStr,
        background: css(bg),
        contrast: round2(contrast(composite, bg)),
        category: '边框太淡',
        tag: el.tagName.toLowerCase(),
      });
    }
  }

  /* ── 4. 图标（SVG 的 fill / stroke 才是真正着色的属性） ───────── */
  for (const el of all) {
    if (el.nodeType !== 1) continue;
    if (el.tagName.toLowerCase() !== 'svg') continue;
    if (!isRendered(el)) continue;
    const cs = getComputedStyle(el);
    const opacity = parseFloat(cs.opacity);
    if (opacity === 0) continue;
    const fill = parseColor(cs.fill);
    const stroke = parseColor(cs.stroke);
    // 描边图标（tabler）优先取 stroke；填充图标取 fill
    const pick = stroke && stroke.a > 0 ? { c: stroke, from: 'stroke' } : fill && fill.a > 0 ? { c: fill, from: 'fill' } : null;
    if (!pick) continue;
    const { bg } = effectiveBackground(el);
    const fg = over({ ...pick.c, a: pick.c.a * opacity }, bg);
    res.icon.push({
      selector: cssPath(el),
      tag: 'svg',
      text: (el.getAttribute('aria-label') || el.getAttribute('title') || '(纯图标)').slice(0, 40),
      color: css(fg),
      colorRaw: cs[pick.from],
      background: css(bg),
      contrast: round2(contrast(fg, bg)),
      opacity: round2(opacity),
      category: '图标不可见',
    });
  }

  return res;
}

/* ═══════════════════════════════════════════════════════════════
 * Node 侧：聚合 / 判定 / 输出
 * ═══════════════════════════════════════════════════════════════ */

/** 按「类别+颜色+底色+对比度+文本」去重合并，避免同一处配色刷屏 */
function dedupe(records) {
  const map = new Map();
  for (const r of records) {
    const key = [r.category, r.color, r.background, r.contrast, r.text].join('|');
    const hit = map.get(key);
    if (hit) {
      hit.occurrences += 1;
      if (hit.sampleSelectors.length < 3 && !hit.sampleSelectors.includes(r.selector)) {
        hit.sampleSelectors.push(r.selector);
      }
    } else {
      map.set(key, { ...r, occurrences: 1, sampleSelectors: [r.selector] });
    }
  }
  return [...map.values()];
}

function textSeverity(c) {
  if (c < 1.5) return 'blocker';
  if (c < 2.25) return 'high';
  return 'medium';
}
function borderSeverity(c) {
  if (c < 1.0) return 'high';
  return 'medium';
}

let issueSeq = 0;

function classifyTextRecord(r, page, scopeKind) {
  const warnLimit = r.largeText ? 3.0 : TH.textWarn; // 大字号 AA 门槛就是 3:1
  if (r.contrast < TH.textIssue) {
    return { level: 'issue', severity: textSeverity(r.contrast) };
  }
  if (r.contrast < warnLimit) {
    return { level: 'advisory', severity: 'low' };
  }
  return { level: 'ok' };
}

async function shoot(page, file) {
  await page.screenshot({ path: `${OUT_DIR}/${file}`, fullPage: false });
  return `accept/darkmode-audit/${file}`;
}

/** 等待页面渲染稳定：networkidle + 字体/动画落定 */
async function settle(page, ms = 900) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

/** 确认 html.dark 真的挂上了（theme 存的是 JSON 字符串） */
async function ensureDark(page) {
  return page.evaluate(() => {
    const dark = document.documentElement.classList.contains('dark');
    if (!dark) {
      try {
        localStorage.setItem('hifin:theme', 'dark'); // jotai 非 JSON 兜底
      } catch {
        /* ignore */
      }
    }
    return {
      dark,
      stored: localStorage.getItem('hifin:theme'),
      htmlClass: document.documentElement.className,
    };
  });
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT, colorScheme: 'dark' });
  // 每次导航前都注入主题，避免首帧闪白导致误判
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('hifin:theme', '"dark"');
    } catch {
      /* ignore */
    }
  });
  const page = await ctx.newPage();

  const runtimeErrors = [];
  page.on('pageerror', (e) => runtimeErrors.push(`pageerror: ${e}`));
  page.on('console', (m) => {
    if (m.type() === 'error') runtimeErrors.push(`console: ${m.text()}`);
  });

  const issues = [];
  const advisories = [];
  const pageReports = [];
  const modalReports = [];
  const darkState = { checked: [], allDark: true };

  const ingest = (scan, ctxInfo) => {
    const groups = [
      { list: scan.text, kind: 'text' },
      { list: scan.placeholder, kind: 'placeholder' },
      { list: scan.icon, kind: 'icon' },
    ];
    const counts = { text: 0, placeholder: 0, border: scan.border.length, icon: 0, deduped: 0 };

    for (const g of groups) {
      counts[g.kind] = g.list.length;
      for (const r of dedupe(g.list)) {
        const verdict =
          g.kind === 'text' || g.kind === 'placeholder'
            ? classifyTextRecord(r, ctxInfo.page, ctxInfo.scopeKind)
            : r.contrast < TH.textIssue
              ? { level: 'issue', severity: textSeverity(r.contrast) }
              : { level: 'ok' };
        if (verdict.level === 'ok') continue;
        const rec = {
          id: `DM-${String(++issueSeq).padStart(3, '0')}`,
          category: r.category,
          kind: g.kind,
          level: verdict.level,
          severity: verdict.severity,
          page: ctxInfo.page,
          route: ctxInfo.route,
          scope: ctxInfo.scope,
          selector: r.selector,
          text: r.text,
          color: r.color,
          colorRaw: r.colorRaw,
          background: r.background,
          contrast: r.contrast,
          threshold: g.kind === 'text' || g.kind === 'placeholder' ? TH.textIssue : TH.textIssue,
          largeText: !!r.largeText,
          fontSize: r.fontSize,
          disabled: !!r.disabled,
          occurrences: r.occurrences,
          sampleSelectors: r.sampleSelectors,
        };
        (verdict.level === 'issue' ? issues : advisories).push(rec);
        counts.deduped += 1;
      }
    }

    // 边框
    for (const r of dedupe(scan.border.map((b) => ({ ...b, text: `${b.tag} ${b.side} ${b.widthPx}px` })))) {
      if (r.contrast >= TH.borderWarn) continue;
      const level = r.contrast < TH.borderIssue ? 'issue' : 'advisory';
      const rec = {
        id: `DM-${String(++issueSeq).padStart(3, '0')}`,
        category: r.category,
        kind: 'border',
        level,
        severity: level === 'issue' ? borderSeverity(r.contrast) : 'low',
        page: ctxInfo.page,
        route: ctxInfo.route,
        scope: ctxInfo.scope,
        selector: r.selector,
        text: r.text,
        color: r.color,
        colorRaw: r.colorRaw,
        background: r.background,
        contrast: r.contrast,
        threshold: TH.borderIssue,
        occurrences: r.occurrences,
        sampleSelectors: r.sampleSelectors,
      };
      (level === 'issue' ? issues : advisories).push(rec);
      counts.deduped += 1;
    }

    return {
      ...counts,
      hiddenByOpacity: scan.hiddenByOpacity,
      intentionallyTransparent: scan.intentionallyTransparent,
      unparsed: scan.unparsed,
      notes: scan.notes,
    };
  };

  /* ── 阶段 1：9 个页面 ─────────────────────────────────────────── */
  for (const p of PAGES) {
    process.stdout.write(`[page] ${p.route} … `);
    await page.goto(`${BASE}${p.route}`, { waitUntil: 'domcontentloaded' }).catch((e) => {
      process.stdout.write(`导航失败 ${e.message} `);
    });
    await settle(page);
    const dark = await ensureDark(page);
    if (!dark.dark) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await settle(page, 1200);
    }
    const dark2 = await ensureDark(page);
    darkState.checked.push({ route: p.route, ...dark2 });
    if (!dark2.dark) darkState.allDark = false;

    const shot = await shoot(page, `${p.name}.png`);
    const scan = await page.evaluate(scanInPage, { scope: null });
    const counts = ingest(scan, { page: p.name, route: p.route, scope: 'page', scopeKind: 'page' });

    pageReports.push({
      page: p.name,
      route: p.route,
      screenshot: shot,
      darkClassApplied: dark2.dark,
      storedTheme: dark2.stored,
      ...counts,
    });
    console.log(
      `文字${counts.text} ph${counts.placeholder} 边框${counts.border} 图标${counts.icon} → 问题${counts.deduped}`,
    );
  }

  /* ── 阶段 2：Modal ───────────────────────────────────────────── */
  for (const m of MODALS) {
    process.stdout.write(`[modal] ${m.name} … `);
    const scope = m.scope || MODAL_SCOPE;
    let openNote = m.open ? null : 'URL 参数自动打开';
    try {
      await page.goto(`${BASE}${m.route}`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      if (m.open) {
        const r = await m.open(page);
        if (r === null) {
          modalReports.push({ modal: m.name, route: m.route, opened: false, note: m.note, reason: '未找到触发元素' });
          console.log('未找到触发元素，跳过');
          continue;
        }
        openNote = r;
      }
      // 等 Modal 入场动画结束
      await page.waitForSelector(scope, { timeout: 10000 });
      await page.waitForTimeout(700);

      const shot = await shoot(page, `modal-${m.name}.png`);
      const scan = await page.evaluate(scanInPage, { scope });
      const counts = ingest(scan, {
        page: `${m.name}`,
        route: m.route,
        scope: 'modal',
        scopeKind: 'modal',
      });
      modalReports.push({
        modal: m.name,
        route: m.route,
        note: m.note,
        scope,
        openStrategy: openNote,
        opened: true,
        screenshot: shot,
        ...counts,
      });
      console.log(
        `文字${counts.text} ph${counts.placeholder} 边框${counts.border} 图标${counts.icon} → 问题${counts.deduped}`,
      );
    } catch (e) {
      modalReports.push({ modal: m.name, route: m.route, opened: false, note: m.note, reason: String(e.message || e) });
      console.log(`失败：${e.message || e}`);
    }
    // 关闭残留 Modal，避免影响下一个
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  /* ── 汇总 ───────────────────────────────────────────────────── */
  const byCategory = {};
  const byPage = {};
  for (const i of issues) {
    byCategory[i.category] = (byCategory[i.category] || 0) + 1;
    byPage[i.page] = (byPage[i.page] || 0) + 1;
  }
  const advisoryByCategory = {};
  for (const i of advisories) advisoryByCategory[i.category] = (advisoryByCategory[i.category] || 0) + 1;

  // 按严重度 + 对比度升序，最严重的排前面
  const sevRank = { blocker: 0, high: 1, medium: 2, low: 3 };
  issues.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || a.contrast - b.contrast);
  advisories.sort((a, b) => a.contrast - b.contrast);

  const unparsedAll = [...new Set([...pageReports, ...modalReports].flatMap((r) => r.unparsed || []))];

  const report = {
    meta: {
      generatedAt: new Date().toISOString(),
      tool: 'accept/scripts/darkmode-audit.mjs',
      baseUrl: BASE,
      viewport: VIEWPORT,
      darkMode: {
        localStorage: 'hifin:theme = "dark"（jotai JSON 格式）',
        emulateMedia: 'colorScheme: dark',
        verifiedHtmlDarkClass: darkState.allDark,
        perRoute: darkState.checked,
      },
      contrastFormula: '(L1 + 0.05) / (L2 + 0.05), L = 0.2126R + 0.7152G + 0.0722B (sRGB→linear)',
      backgroundResolution: '向上遍历祖先链至首个不透明层，再自外向内 alpha 合成',
      thresholds: TH,
      knownTradeoffs: [
        'computed opacity === 0 的 hover 才显形元素记入 hiddenByOpacity，不计入 issues',
        'color alpha === 0（text-transparent 占位）记入 intentionallyTransparent，不计入 issues',
        '扫描覆盖整个 DOM（不限于首屏视口），截图才使用 fullPage:false',
        'advisories 为 3:1 ≤ contrast < 4.5（文字/图标）或 1.5 ≤ contrast < 3（边框），非硬性问题',
      ],
      pagesScanned: pageReports.length,
      modalsScanned: modalReports.filter((m) => m.opened).length,
      runtimeErrors,
    },
    summary: {
      totalIssues: issues.length,
      totalAdvisories: advisories.length,
      byCategory,
      advisoryByCategory,
      byPage,
      pagesWithIssues: Object.keys(byPage),
    },
    pages: pageReports,
    modals: modalReports,
    issues,
    advisories,
    unparsedColors: unparsedAll,
  };

  writeFileSync(`${OUT_DIR}/issues.json`, `${JSON.stringify(report, null, 2)}\n`);

  await browser.close();

  /* ── 控制台摘要 ─────────────────────────────────────────────── */
  console.log('\n================ 暗黑模式审计结果 ================');
  console.log(`页面 ${pageReports.length} 个，Modal ${report.meta.modalsScanned}/${MODALS.length} 个成功打开`);
  console.log(`html.dark 全部生效：${darkState.allDark ? '是' : '否 ⚠'}`);
  console.log(`问题总数：${issues.length}　advisory：${advisories.length}`);
  console.log('\n按分类：');
  for (const [k, v] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  console.log('\n涉及页面/弹窗：');
  for (const [k, v] of Object.entries(byPage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k}: ${v}`);
  }
  if (issues.length) {
    console.log('\n最严重 25 条：');
    for (const i of issues.slice(0, 25)) {
      console.log(
        `  [${i.severity}] ${i.id} ${i.category} ${i.contrast}:1 「${i.text}」 ${i.color} on ${i.background} ×${i.occurrences} @ ${i.page} ${i.selector}`,
      );
    }
  }
  if (unparsedAll.length) console.log(`\n⚠ 无法解析的颜色写法：${unparsedAll.slice(0, 5).join(', ')}`);
  console.log(`\n输出：${OUT_DIR}/issues.json`);
}

await main();
