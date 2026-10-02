/**
 * border-contrast.mjs — 暗黑模式边框 WCAG 3:1 验收
 * ------------------------------------------------------------------
 * 背景：tailwind.config.js 的 border.dark 原为 #272a31，对页面底 #0f1115 只有
 *      1.32:1、对卡片底 #171a21 只有 1.21:1（WCAG 2.1 SC 1.4.11 非文本对比度
 *      要求 ≥3:1），全站边框在暗黑模式下几乎不可见。
 *
 * 做法：脚本自己拉起 vite（端口 5188，自查端口，不碰 8787 / 5199），
 *      暗黑 + 浅色两套主题各访问 /home /account/list /transaction /settings，
 *      用 getComputedStyle 抽出**实际渲染**的 border-color（逐边，取真实绘制的
 *      最弱一侧）以及该边框内外两侧的**合成后**有效背景色（逐层祖先回溯 + alpha
 *      合成），算 WCAG 相对亮度对比度并断言。
 *
 * 判定口径：
 *   - 契约表面 = 页面底 #0f1115 与卡片底 #171a21。落在契约表面上的 border.dark
 *     边框必须 ≥ 3:1，这是本任务的验收红线。
 *   - 非契约表面（半透明彩色徽章合成色、Tailwind 调色板色等）单独归入
 *     outOfContract 报告，不计失败，但会打印出来供调度方判断。
 *   - 非 border.dark 的边框（错误红、品牌色等语义边框）同样单独归类，
 *     不属本次单 token 改动范围。
 *   浅色主题只做截图与基线记录，不施加 3:1 断言（border.DEFAULT 未经本次改动）。
 *
 * 用法：node accept/scripts/border-contrast.mjs
 */
import { chromium } from '/home/saltedfish/project/hifin/node_modules/playwright/index.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/* ───────────────────── 常量 ───────────────────── */

const PORT = 5188;
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUT = 'accept/screenshots/border-contrast';
const API = process.env.CORE_URL ?? 'http://127.0.0.1:8787';
const MIN_RATIO = 3.0;

/** 契约表面：本次修复必须保证达标的两种暗黑底色 */
const CONTRACT_BGS = { '#0f1115': '页面底 bg-dark', '#171a21': '卡片底 bg-card-dark' };
/** 本次改动的 border.dark（与 app/tailwind.config.js 保持同步） */
const BORDER_DARK = '#5f6875';

/** 浅色主题契约底色（仅用于打印参考，不参与断言） */
const PAGES = [
  { path: '/home', name: '看板', shot: 'home' },
  { path: '/account/list', name: '账户', shot: 'account-list' },
  { path: '/transaction', name: '交易', shot: 'transaction' },
  { path: '/settings', name: '设置', shot: 'settings' },
];

mkdirSync(OUT, { recursive: true });

/* ───────────────────── 颜色数学（WCAG 2.1） ───────────────────── */

const hex2rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const rgb2hex = ([r, g, b]) =>
  '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');

/** sRGB 8bit 通道 → 线性光 */
function channel(v) {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
/** WCAG 相对亮度 */
function luminance([r, g, b]) {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
/** 对比度 (L1+0.05)/(L2+0.05) */
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

const ratioTo = (fgHex, bgHex) => contrast(hex2rgb(fgHex), hex2rgb(bgHex));

/* ───────────────────── vite 生命周期 ───────────────────── */

let vite = null;

async function waitForVite(timeoutMs = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(BASE, { signal: AbortSignal.timeout(2000) });
      if (res.ok || res.status === 404) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(400);
  }
  return false;
}

function startVite() {
  // detached 让 vite 及其子进程成组，便于整组回收
  vite = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: 'app',
    detached: true,
    stdio: 'ignore',
  });
  vite.unref();
}

function stopVite() {
  if (vite?.pid) {
    try {
      process.kill(-vite.pid, 'SIGTERM');
    } catch {
      /* 组可能已退出 */
    }
  }
  // 兜底：只按本脚本的端口号精确清理，绝不裸 pkill vite
  spawn('pkill', ['-f', `vite.*${PORT}`], { stdio: 'ignore' }).unref();
}

/* ───────────────────── 页面内采集 ───────────────────── */

/**
 * 采集当前页面所有真实绘制的边框及其内外有效背景。
 * 该函数整体在浏览器上下文中执行，__BORDER_DARK__ / __CONTRACT__ 由外部注入。
 */
function collectBorders(opts) {
  const { BORDER_DARK_HEX, CONTRACT_BGS } = opts;

  /* ── 颜色数学：必须定义在本函数内，page.evaluate 不会带闭包外的 Node 作用域 ── */
  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const channel = (v) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  const contrast = (a, b) => {
    const la = luminance(a);
    const lb = luminance(b);
    const [hi, lo] = la > lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };

  function parseColor(str) {
    if (!str) return null;
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    if (/^#?[0-9a-f]{6}$/i.test(str)) {
      const h = str[0] === '#' ? str.slice(1) : str;
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: 1,
      };
    }
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      if (p.length < 3 || p.some(Number.isNaN)) return null;
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    return null;
  }

  const composite = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });

  const toHex = (c) =>
    '#' +
    [c.r, c.g, c.b]
      .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'))
      .join('');

  /**
   * 逐层祖先收集 background-color，再由最外层向内做 alpha 合成，
   * 得到 el 所处的真实表面色。
   * chain 顺序是「内 → 外」，所以基准取**最外层的不透明色**，
   * 再把比它更靠内的各层依次盖上去。
   */
  function effectiveSurface(start) {
    const chain = [];
    let n = start;
    let gradient = false;
    while (n && n.nodeType === 1) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') gradient = true;
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) {
        chain.push({ tag: n.tagName.toLowerCase(), hex: toHex(c), a: c.a });
      }
      n = n.parentElement;
    }
    // 基准：最外层的不透明底；全链都半透明则整链盖到白色画布上
    let base = { r: 255, g: 255, b: 255, a: 1 };
    let baseIdx = -1;
    for (let i = chain.length - 1; i >= 0; i--) {
      if (chain[i].a === 1) {
        baseIdx = i;
        break;
      }
    }
    if (baseIdx >= 0) base = parseColor(chain[baseIdx].hex);
    // 由外向内叠加；无不透明层时 startIdx 指向最外层，整链都参与
    const startIdx = baseIdx >= 0 ? baseIdx - 1 : chain.length - 1;
    for (let i = startIdx; i >= 0; i--) {
      base = composite({ ...parseColor(chain[i].hex), a: chain[i].a }, base);
    }
    return { hex: toHex(base), gradient, depth: chain.length };
  }

  const isContract = (hex) => Object.prototype.hasOwnProperty.call(CONTRACT_BGS, hex);
  const target = BORDER_DARK_HEX.toLowerCase();

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (cs.opacity !== '' && parseFloat(cs.opacity) === 0) continue;

    // 逐边取真实绘制的边框（宽度>0 且 style 非 none），取对比度最差的一侧
    const sides = [];
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const w = parseFloat(cs['border' + side + 'Width'] || '0');
      const st = cs['border' + side + 'Style'];
      const col = parseColor(cs['border' + side + 'Color']);
      if (!(w > 0) || st === 'none' || !col || col.a === 0) continue;
      sides.push({ side: side.toLowerCase(), width: w, hex: toHex(col), a: col.a, rgb: col });
    }
    if (!sides.length) continue;

    // 边框内侧表面 = 元素自身合成底；外侧表面 = 父级合成底（border 画在父底上）
    const inside = effectiveSurface(el);
    const outside = effectiveSurface(el.parentElement);

    const key = `${el.tagName}|${sides.map((s) => s.side + s.hex).join(',')}|${inside.hex}|${outside.hex}|${(el.className || '').toString().slice(0, 60)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const worst = sides
      .map((s) => {
        const c = s.a < 1 ? composite(s.rgb, { ...parseColor(outside.hex), a: 1 }) : s.rgb;
        return {
          side: s.side,
          width: s.width,
          color: toHex(c),
          vsInside: contrast([c.r, c.g, c.b], hexToRgb(inside.hex)),
          vsOutside: contrast([c.r, c.g, c.b], hexToRgb(outside.hex)),
        };
      })
      .reduce((a, b) => (Math.min(a.vsInside, a.vsOutside) <= Math.min(b.vsInside, b.vsOutside) ? a : b));

    out.push({
      tag: el.tagName.toLowerCase(),
      cls: (el.className || '').toString().replace(/\s+/g, ' ').trim().slice(0, 110),
      isBorderDarkToken: worst.color === target,
      isContractSurface: isContract(inside.hex) && isContract(outside.hex),
      inside: inside.hex,
      outside: outside.hex,
      gradient: inside.gradient || outside.gradient,
      side: worst.side,
      color: worst.color,
      minRatio: Math.min(worst.vsInside, worst.vsOutside),
      insideRatio: worst.vsInside,
      outsideRatio: worst.vsOutside,
    });
  }
  return out;
}

/* ───────────────────── 主流程 ───────────────────── */

const results = [];
let contractFail = 0;
let contractChecked = 0;

function fmt(n) {
  return n.toFixed(3);
}

const browser = await chromium.launch();

try {
  // 自检：core 必须在 8787
  let coreUp = false;
  try {
    const r = await fetch(API + '/api/accounts', { signal: AbortSignal.timeout(3000) });
    coreUp = r.ok || r.status === 401;
  } catch {
    /* 下面会报 */
  }
  console.log(`core :8787 ${coreUp ? '在线' : '⚠️ 不可达（页面可能空态，仍继续）'}`);

  startVite();
  const up = await waitForVite();
  if (!up) throw new Error(`vite 未能在 ${PORT} 端口就绪`);
  console.log(`vite :${PORT} 已就绪 (${BASE})`);
  await sleep(800);

  for (const theme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(
      ([t]) => {
        localStorage.setItem('hifin:theme', JSON.stringify(t));
        localStorage.setItem('hifin:spaceId', '1');
      },
      [theme],
    );

    for (const p of PAGES) {
      const page = await ctx.newPage();
      await page.goto(BASE + p.path, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(1200);

      // 确认主题真的生效了
      const themeOn = await page.evaluate(() => document.documentElement.classList.contains('dark'));
      if (theme === 'dark' && !themeOn) {
        console.log(`✗ ${p.name} ${p.path}: html.dark 未生效`);
        contractFail++;
      }
      if (theme === 'dark' && themeOn) {
        const borders = await page.evaluate(collectBorders, {
          BORDER_DARK_HEX: BORDER_DARK,
          CONTRACT_BGS,
        });
        const mine = borders.filter((b) => b.isBorderDarkToken);
        const contract = mine.filter((b) => b.isContractSurface);
        const outOfContract = mine.filter((b) => !b.isContractSurface);
        const failed = contract.filter((b) => b.minRatio < MIN_RATIO);

        contractChecked += contract.length;
        contractFail += failed.length;

        const worst = contract.slice().sort((a, b) => a.minRatio - b.minRatio)[0];
        results.push({
          页面: `${p.name} ${p.path}`,
          borderDark边框数: mine.length,
          契约表面边框数: contract.length,
          不达标数: failed.length,
          最差比值: worst ? `${fmt(worst.minRatio)}:1 (${worst.color} on ${worst.inside}/${worst.outside})` : 'n/a',
          非契约表面: outOfContract.length
            ? {
                数量: outOfContract.length,
                最差: outOfContract
                  .slice()
                  .sort((a, b) => a.minRatio - b.minRatio)
                  .slice(0, 5)
                  .map((b) => `${fmt(b.minRatio)}:1 (${b.color} on ${b.inside}/${b.outside}) «${b.cls.slice(0, 44)}»`),
              }
            : [],
        });

        for (const f of failed.slice(0, 8)) {
          console.log(
            `  ✗ ${p.path} <${f.tag}> ${f.side}边 ${f.color} on ${f.inside}/${f.outside} = ${fmt(f.minRatio)}:1  «${f.cls.slice(0, 70)}»`,
          );
        }
      }

      await page.screenshot({
        path: `${OUT}/${theme}-${p.shot}.png`,
        fullPage: false,
      });
      await page.close();
    }
    await ctx.close();
  }

  /* ── 静态色值核算（设计侧证明，与运行时实测互为印证） ── */
  const staticCalc = {
    'border.dark 新值': BORDER_DARK,
    'border.dark 旧值': '#272a31',
    '对页面底 #0f1115': `3.35:1 → 实际 ${fmt(ratioTo(BORDER_DARK, '#0f1115'))}:1`,
    '对卡片底 #171a21': `3.09:1 → 实际 ${fmt(ratioTo(BORDER_DARK, '#171a21'))}:1`,
    '旧值对 #0f1115': `${fmt(ratioTo('#272a31', '#0f1115'))}:1`,
    '旧值对 #171a21': `${fmt(ratioTo('#272a31', '#171a21'))}:1`,
    '理论最小(保原色相)': '#5e6676 = ' + fmt(ratioTo('#5e6676', '#171a21')) + ':1',
    '备选上限 #6b7280': `${fmt(ratioTo('#6b7280', '#0f1115'))}:1 / ${fmt(ratioTo('#6b7280', '#171a21'))}:1`,
  };

  /* ── 汇总 ── */
  console.log('\n════════ 静态色值核算（WCAG 2.1 相对亮度）════════');
  for (const [k, v] of Object.entries(staticCalc)) console.log(`  ${k.padEnd(20)} ${v}`);

  console.log('\n════════ 运行时实测（暗黑模式，getComputedStyle）════════');
  console.log(JSON.stringify(results, null, 2));

  const total = contractChecked;
  const worstAll = MIN_RATIO;
  console.log('\n════════ 结论 ════════');
  console.log(`契约边框样本数: ${total}`);
  console.log(`低于 ${worstAll}:1 的样本数: ${contractFail}`);
  console.log(
    contractFail === 0 && total > 0
      ? `✅ PASS — 全部 ${total} 条落在 #0f1115 / #171a21 上的 border.dark 边框均 ≥ ${MIN_RATIO}:1`
      : `❌ ${contractFail === 0 ? '未采集到契约样本' : 'FAIL — 有边框低于 ' + MIN_RATIO + ':1'}`,
  );
} finally {
  await browser.close();
  stopVite();
  await sleep(400);
}

/* 清理可能残留的本脚本 vite（只按端口 5188） */
spawn('pkill', ['-f', `vite.*${PORT}`], { stdio: 'ignore' }).unref();

process.exit(contractFail === 0 ? 0 : 1);
