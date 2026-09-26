import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();

// 桌面：发现页 + 天气
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,150)));
await page.goto(base + '/discover', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
const dText = await page.textContent('body');
console.log('发现页:', (dText.includes('财务洞察') && dText.includes('财务小贴士')) ? 'PASS' : 'FAIL');
await page.screenshot({ path: 'accept/final-discover.png' });

await page.goto(base + '/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(4500); // 等天气请求
const hText = await page.textContent('body');
console.log('天气显示:', /°C/.test(hText) ? 'PASS' : 'FAIL(或离线静默)');
await page.screenshot({ path: 'accept/final-weather.png' });
await page.close();

// 移动端 390px
const mp = await browser.newPage({ viewport: { width: 390, height: 844 } });
const pages = ['/home', '/account/list', '/transaction', '/goal/list', '/report/list', '/budget', '/settings', '/ai', '/discover'];
let pass = 0, fail = 0;
for (const p of pages) {
  await mp.goto(base + p, { waitUntil: 'networkidle' });
  await mp.waitForTimeout(600);
  const sw = await mp.evaluate(() => document.documentElement.scrollWidth);
  const ok = sw <= 391;
  console.log(`${ok ? 'PASS' : 'FAIL'} mobile ${p} scrollWidth=${sw}`);
  ok ? pass++ : fail++;
}
// 汉堡菜单
await mp.goto(base + '/home', { waitUntil: 'networkidle' });
await mp.waitForTimeout(500);
const burger = mp.locator('button:visible').first();
await burger.click();
await mp.waitForTimeout(600);
const mText = await mp.textContent('body');
console.log('抽屉导航:', (mText.includes('看板') && mText.includes('账户') && mText.includes('预算')) ? 'PASS' : 'FAIL');
await mp.screenshot({ path: 'accept/mobile-drawer.png' });
console.log(`=== mobile ${pass} pass, ${fail} fail ===`);
console.log('PAGE_ERRORS:', JSON.stringify(errors));
await browser.close();
