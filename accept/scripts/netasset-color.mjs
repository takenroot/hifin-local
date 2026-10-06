/**
 * 回归：金额语义色（2026-10-06 看板重写后新契约）
 * ---------------------------------------------------------------
 * 口径（docs/design-principles.md）：收入=绿、支出=红；好事=绿、坏事=红。
 * 看板重写（zenith 形态）后语义色挂在**环比行**（.text-income/.text-expense），
 * 卡面大数字为中性炭黑——本脚本断言「带语义类的元素实际渲染色与令牌一致」，
 * 防止令牌再次错位（与结构解耦，无论色挂在金额还是环比都成立）。
 * 运行：core :8787 + vite :5199 均需在线。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  const out = [];
  document.querySelectorAll('.text-income, .text-expense').forEach((el) => {
    out.push({
      cls: el.className.match(/text-(income|expense)\b/)?.[1] ?? '?',
      color: getComputedStyle(el).color,
      text: el.textContent?.slice(0, 20) ?? '',
    });
  });
  return out;
});

function chan(rgb, pick) {
  const m = rgb.match(/rgb\((\d+), (\d+), (\d+)\)/);
  return m ? Number(m[pick]) : 0;
}

let failed = 0;
for (const r of rows) {
  const g = chan(r.color, 2);
  const red = chan(r.color, 1);
  const ok = r.cls === 'income' ? g > red : red > g;
  if (!ok) {
    console.log(`✗ ${r.cls} ${r.color} 「${r.text}」`);
    failed += 1;
  }
}
console.log(`语义色元素共 ${rows.length} 个（income=绿 / expense=红）`);
if (rows.length < 2) {
  console.log(`✗ 语义色元素不足 2 个（预期 ≥2）`);
  failed += 1;
}
await browser.close();
if (failed > 0) {
  console.error(`netasset-color: ${failed} 项未过`);
  process.exit(1);
}
console.log('netasset-color: 全部通过（语义类与实际渲染色一致）');
