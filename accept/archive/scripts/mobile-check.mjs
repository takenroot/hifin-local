import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pages = ['/home', '/account/list', '/transaction', '/goal/list', '/report/list', '/budget', '/settings', '/ai'];
let pass = 0, fail = 0;
for (const p of pages) {
  await page.goto(base + p, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  const ok = sw <= 391;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${p} scrollWidth=${sw}`);
  ok ? pass++ : fail++;
  await page.screenshot({ path: `accept/mobile-${p.replace(/\//g,'_')}.png` });
}
// 汉堡菜单开合
await page.goto(base + '/home', { waitUntil: 'networkidle' });
const burger = page.locator('button').first();
await burger.click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'accept/mobile-drawer.png' });
const bodyTxt = await page.textContent('body');
console.log('抽屉导航展开:', bodyTxt.includes('看板') && bodyTxt.includes('账户') ? 'PASS' : 'FAIL');
console.log(`=== ${pass} pass, ${fail} fail ===`);
await browser.close();
