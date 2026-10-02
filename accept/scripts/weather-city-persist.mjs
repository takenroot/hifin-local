import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,150)));

// 1. 打开页面，选呼和浩特
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.click('button[title="切换城市"]');
await page.waitForTimeout(500);
await page.fill('[data-testid="city-search"]', '呼和浩特');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.waitForTimeout(2000);
const afterSelect = await page.textContent('[data-testid="weather-summary"]');
console.log('选后:', afterSelect?.trim());

// 2. 刷新页面，验证还是呼和浩特（不被定位覆盖）
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const afterReload = await page.textContent('[data-testid="weather-summary"]');
console.log('刷新后:', afterReload?.trim());
const pass = afterReload?.includes('呼和浩特');
console.log(pass ? 'PASS 城市选择刷新后保持' : 'FAIL 城市被覆盖');
console.log('ERRORS:', JSON.stringify(errors.slice(0,3)));
await browser.close();
