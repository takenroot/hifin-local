/**
 * wave2-bento-screens.mjs（2026-10-06 bento-motion Wave 2 验收截图）
 * ---------------------------------------------------------------
 * 用法：node accept/scripts/wave2-bento-screens.mjs
 *       假设：vite dev 在 5199（已开）+ core 在 8787（已开）
 *       输出：/tmp/wave2-*.png
 *
 * 验收项：
 *   - /home 桌面 1440 亮色
 *   - /home 桌面 1440 暗色
 *   - /home 移动端 390
 *   - /ai 桌面 1440 暗色
 *   - ⌘K 面板（验证 .glass 落地）
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.HIFIN_BASE || 'http://127.0.0.1:5199';
const OUT = '/tmp';

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();

// 桌面亮色 /home
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  // 等 bento 入场动画结束 + 数据请求回来（最多 2s）
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/wave2-home-light.png`, fullPage: false });
  await ctx.close();
}

// 桌面暗色 /home
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/wave2-home-dark.png`, fullPage: false });
  // 折线以下（还款/账户/目标/预算）应已被 IntersectionObserver 触发入场；
  // 滚动到滚动容器底部再截一张确认底部 row 4 也成型
  await page.evaluate(() => {
    const scroller = document.querySelector('main') ?? document.scrollingElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/wave2-home-dark-bottom.png`, fullPage: false });
  await ctx.close();
}

// 移动端 /home 390
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${OUT}/wave2-home-mobile.png`, fullPage: false });
  // 滚动到底部确认无横向滚动
  await page.evaluate(() => {
    const scroller = document.querySelector('main') ?? document.scrollingElement;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/wave2-home-mobile-bottom.png`, fullPage: false });
  await ctx.close();
}

// /ai 桌面暗色
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/ai`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/wave2-ai-dark.png`, fullPage: false });
  await ctx.close();
}

// ⌘K 命令面板（验证 .glass 落地——不能有动画出现）
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForTimeout(1500);
  await page.keyboard.press('Meta+K');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/wave2-palette.png`, fullPage: false });
  await ctx.close();
}

await browser.close();
console.log('done — see /tmp/wave2-*.png');