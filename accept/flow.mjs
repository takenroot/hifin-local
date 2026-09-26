import { chromium } from 'playwright';
const base = 'http://localhost:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0,150)); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + String(e).slice(0,150)));

// 1. 新建账户完整流程
await page.goto(base + '/account/list', { waitUntil: 'networkidle' });
await page.locator('button', { hasText: '新建账户' }).first().click();
await page.waitForTimeout(400);
await page.locator('text=资金').first().click();
await page.waitForTimeout(200);
await page.locator('button', { hasText: '下一步' }).click();
await page.waitForTimeout(400);
await page.locator('input').first().fill('招商储蓄卡');
await page.locator('input[type=number], input[inputmode=decimal]').first().fill('1000').catch(()=>{});
await page.screenshot({ path: 'accept/f1-account-form.png' });
await page.locator('button', { hasText: '确认' }).click();
await page.waitForTimeout(800);
await page.screenshot({ path: 'accept/f2-account-created.png' });
const bodyText1 = await page.textContent('body');
console.log('账户创建成功:', bodyText1.includes('招商储蓄卡'));

// 2. 新建流水
await page.goto(base + '/transaction?create=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
await page.screenshot({ path: 'accept/f3-tx-form.png' });
const nameInput = page.locator('input').first();
await nameInput.fill('工资');
await page.locator('button:has-text("收入"), [role=tab]:has-text("收入")').first().click().catch(()=>{});
await page.screenshot({ path: 'accept/f3b-tx-income.png' });

// 3. 命令面板
await page.goto(base + '/home', { waitUntil: 'networkidle' });
await page.keyboard.press('Control+k');
await page.waitForTimeout(600);
await page.screenshot({ path: 'accept/f4-cmdk.png' });
const cmdkVisible = (await page.textContent('body')).includes('新建流水');
console.log('命令面板打开:', cmdkVisible);
await page.keyboard.press('Escape');

// 4. 用户ID检查
await page.goto(base + '/settings', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const bodyText2 = await page.textContent('body');
const idMatch = bodyText2.match(/本地用户 ID[\s\S]{0,400}/);
console.log('用户ID区域:', JSON.stringify(idMatch ? idMatch[0].slice(0,200) : 'N/A'));

// 5. 暗黑模式
await page.locator('text=个性偏好').first().click();
await page.waitForTimeout(500);
await page.screenshot({ path: 'accept/f5-prefs.png' });

console.log('CONSOLE_ERRORS:', JSON.stringify(errors.slice(0,8)));
await browser.close();
