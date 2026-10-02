import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
// 强制暗黑模式
await page.emulateMedia({ colorScheme: 'dark' });
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'networkidle' });
await page.evaluate(() => localStorage.setItem('hifin:theme', '"dark"'));
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 打开编辑流水 Modal
await page.goto('http://127.0.0.1:5199/transaction?create=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

// 检查 label 颜色
const labels = await page.evaluate(() => {
  const labels = document.querySelectorAll('.text-sm.text-text-muted, .text-sm.text-text-muted-dark');
  return Array.from(labels).slice(0, 5).map(l => ({
    text: l.textContent?.slice(0, 10),
    color: getComputedStyle(l).color,
    cls: String(l.className).match(/text-text-muted(-dark)?/)?.[0]
  }));
});
console.log('暗黑模式 label:', JSON.stringify(labels, null, 2));
await page.screenshot({ path: 'accept/darkmode-form.png' });
await browser.close();
