import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(2000);
const result = await page.evaluate(() => {
  // 找所有大数字金额
  const amounts = document.querySelectorAll('.text-2xl');
  return Array.from(amounts).map(a => ({
    text: a.textContent?.slice(0, 20),
    cls: String(a.className).match(/text-(income|expense)/)?.[0] || 'none',
    color: getComputedStyle(a).color
  }));
});
console.log('所有金额:', JSON.stringify(result, null, 2));
await page.screenshot({ path: 'accept/netasset-fresh.png' });
await browser.close();
