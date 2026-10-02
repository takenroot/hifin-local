import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
// 检查趋势图 stroke 颜色
const stroke = await page.evaluate(() => {
  const path = document.querySelector('.recharts-area-curve');
  return path ? path.getAttribute('stroke') : 'not found';
});
console.log('趋势图 stroke:', stroke);
await page.screenshot({ path: 'accept/chart-color.png' });
await browser.close();
