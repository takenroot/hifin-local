import { chromium } from 'playwright';
const base = 'http://localhost:5199';
const pages = [
  ['/home', 'home'], ['/account/list', 'accounts'], ['/transaction', 'transactions'],
  ['/goal/list', 'goals'], ['/report/list', 'reports'], ['/settings', 'settings'],
];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0, 200)));
for (const [path, name] of pages) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `accept/${name}.png` });
  console.log(name, '| title:', await page.title(), '| body文本长度:', (await page.textContent('body'))?.length);
}
// 功能冒烟：命令面板 + 新建账户流程
await page.goto(base + '/account/list', { waitUntil: 'networkidle' });
await page.keyboard.press('Control+k');
await page.waitForTimeout(500);
await page.screenshot({ path: 'accept/cmdk.png' });
await page.keyboard.press('Escape');
// 新建账户：资金/招商银行/余额1000
const newBtn = page.locator('button', { hasText: '新建账户' }).first();
await newBtn.click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'accept/account-step1.png' });
await page.locator('text=资金').first().click();
await page.waitForTimeout(300);
const nameInput = page.locator('input').first();
await nameInput.fill('招商储蓄卡');
await page.screenshot({ path: 'accept/account-step2.png' });
console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0, 10)));
await browser.close();
