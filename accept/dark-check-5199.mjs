/**
 * HiFin 暗黑模式对比度冒烟测试
 *
 * - 打开 4 个核心页面 (/home /account/list /transaction /settings)
 * - 强制写入 localStorage 'hifin:theme' = '"dark"' 后 reload
 * - 截图保存到 accept/ 目录
 * - 对 body 背景 + 关键标题做最低对比度断言
 */
import { chromium } from '/home/saltedfish/project/hifin/node_modules/playwright/index.mjs';

const BASE = 'http://localhost:5199';
const PAGES = [
  { path: '/home', shot: 'dark-home.png' },
  { path: '/account/list', shot: 'dark-accounts.png' },
  { path: '/transaction', shot: 'dark-transactions.png' },
  { path: '/settings', shot: 'dark-settings.png' },
];

const report = {
  pass: 0,
  fail: 0,
  results: [],
};

function parseRgb(s) {
  // "rgb(15, 17, 21)" or "rgba(...)"
  const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function brightnessSum(rgb) {
  if (!rgb) return 0;
  return rgb[0] + rgb[1] + rgb[2];
}

function isLight(rgb) {
  // 亮度估计：sum > 384 ~ 平均 > 128
  return brightnessSum(rgb) > 384;
}

function isDark(rgb) {
  return brightnessSum(rgb) < 384;
}

function titleIsLight(rgb) {
  // "标题颜色不是接近黑色" —— sum > 150
  return brightnessSum(rgb) > 150;
}

function record(name, ok, detail) {
  report.results.push({ name, ok, detail });
  if (ok) report.pass++; else report.fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  for (const p of PAGES) {
    const url = BASE + p.path;
    // 先打开一次以建立 origin，再写入 localStorage，再 reload
    await page.goto(BASE + '/home', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      try { localStorage.setItem('hifin:theme', '"dark"'); } catch (e) {}
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    // 给 React 一点时间 hydrate / 应用样式
    await page.waitForTimeout(400);

    const shotPath = '/home/saltedfish/project/hifin/accept/' + p.shot;
    await page.screenshot({ path: shotPath, fullPage: false });
    console.log(`screenshot: ${shotPath}`);

    // 1) document.body 背景是否为深色
    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const bodyRgb = parseRgb(bodyBg);
    record(
      `[${p.path}] body background is dark`,
      !!bodyRgb && isDark(bodyRgb),
      `body bg=${bodyBg} rgb=${JSON.stringify(bodyRgb)} sum=${brightnessSum(bodyRgb)}`,
    );

    // 2) h1 / h2 / 主要标题元素的颜色亮度
    const titles = await page.evaluate(() => {
      const out = [];
      const sel = 'h1, h2, h3, header div, .section-title, [data-testid="page-title"]';
      const els = Array.from(document.querySelectorAll(sel));
      for (const el of els.slice(0, 12)) {
        const txt = (el.textContent || '').trim();
        if (!txt) continue;
        const cs = getComputedStyle(el);
        out.push({ tag: el.tagName, text: txt.slice(0, 30), color: cs.color });
      }
      return out;
    });

    let titlesChecked = 0;
    for (const t of titles) {
      const rgb = parseRgb(t.color);
      if (!rgb) continue;
      titlesChecked++;
      const ok = titleIsLight(rgb);
      if (!ok) {
        record(
          `[${p.path}] title text not near-black (${t.tag} "${t.text}")`,
          false,
          `color=${t.color} rgb=${JSON.stringify(rgb)} sum=${brightnessSum(rgb)}`,
        );
      }
    }
    record(
      `[${p.path}] titles checked (${titlesChecked})`,
      titlesChecked > 0,
      `${titlesChecked} title elements sampled`,
    );
  }
} finally {
  await browser.close();
}

console.log('\n=== SUMMARY ===');
console.log(`PASS: ${report.pass}`);
console.log(`FAIL: ${report.fail}`);
console.log(`TOTAL: ${report.pass + report.fail}`);
process.exit(report.fail === 0 ? 0 : 1);