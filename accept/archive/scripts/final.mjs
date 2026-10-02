import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:5199/home', { waitUntil: 'networkidle' });
await page.keyboard.press('Control+k');
await page.waitForTimeout(600);
await page.screenshot({ path: 'accept/final-cmdk.png' });
await page.keyboard.press('Escape');
// 暗黑模式
await page.evaluate(() => localStorage.setItem('hifin:theme', '"dark"'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'accept/final-dark.png' });
await browser.close();
console.log('done');
