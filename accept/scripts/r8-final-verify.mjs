import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,150)));

// 1. 语言 Select 弹层渲染
await page.goto(base + '/settings?section=preferences', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const langTrigger = page.locator('[role=combobox]').first();
await langTrigger.click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'accept/r8-final-lang-open.png' });
const langText = await page.textContent('body');
console.log('语言弹层渲染:', /简体中文|English/.test(langText) ? 'PASS' : 'FAIL');

// 选中后弹层关闭 + trigger 显示
await page.locator('[role=option]', { hasText: 'English' }).click();
await page.waitForTimeout(400);
const triggerText = await langTrigger.textContent();
console.log('选中后 trigger 显示:', triggerText?.includes('English') ? 'PASS' : 'FAIL');
await page.screenshot({ path: 'accept/r8-final-lang-selected.png' });

// 2. Esc 关闭
await langTrigger.click();
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const isOpen = await page.locator('[role=listbox]').count();
console.log('Esc 关闭:', isOpen === 0 ? 'PASS' : 'FAIL');

// 3. 账户 Select（先建一个账户）
await page.goto(base + '/account/list?create=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.locator('text=资金').first().click();
await page.waitForTimeout(200);
await page.locator('button', { hasText: '下一步' }).click();
await page.waitForTimeout(400);
await page.locator('input').first().fill('测试账户');
await page.locator('button', { hasText: '确认' }).click();
await page.waitForTimeout(600);

await page.goto(base + '/transaction?create=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
// 找账户 combobox
const accTrigger = page.locator('[role=combobox]').last();
await accTrigger.click();
await page.waitForTimeout(400);
await page.screenshot({ path: 'accept/r8-final-account-open.png' });
const accText = await page.textContent('body');
console.log('账户弹层含账户名:', accText.includes('测试账户') ? 'PASS' : 'FAIL');

console.log('PAGE_ERRORS:', JSON.stringify(errors.slice(0,5)));
await browser.close();
