import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/transaction', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const colors = await page.evaluate(() => {
  const els = document.querySelectorAll('[class*="text-income"], [class*="text-expense"]');
  return Array.from(els).slice(0, 5).map(e => ({
    cls: String(e.className).match(/text-(income|expense)/)?.[0],
    color: getComputedStyle(e).color,
    text: e.textContent?.slice(0, 20)
  }));
});
console.log(JSON.stringify(colors, null, 2));
await page.screenshot({ path: 'accept/color-verify.png' });
await browser.close();
