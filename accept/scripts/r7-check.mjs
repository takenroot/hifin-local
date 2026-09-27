import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,200)));

// 1) 眼睛切换金额显示
await page.goto(base + '/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const beforeAmount = await page.textContent('body');
const beforeHasMoney = /¥\s*0\.00/.test(beforeAmount);
const beforeHasMask = /¥\s*•/.test(beforeAmount);
console.log('切换前:', beforeHasMoney && !beforeHasMask ? '金额可见 OK' : 'FAIL');
await page.screenshot({ path: 'accept/r7-eye-before.png' });
const eyeBtn = page.locator('button[aria-label*="金额"], button[title*="金额"], button[aria-pressed]').first();
await eyeBtn.click();
await page.waitForTimeout(500);
const afterAmount = await page.textContent('body');
const afterHasMask = /¥\s*•/.test(afterAmount);
console.log('切换后:', afterHasMask ? '金额被遮蔽 OK' : 'FAIL');
await page.screenshot({ path: 'accept/r7-eye-after.png' });

// 2) 保存按钮文字一行（去 settings 用户信息页）
await page.goto(base + '/settings?section=profile', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const saveBtn = page.locator('button', { hasText: '保存' }).first();
const box = await saveBtn.boundingBox();
console.log('保存按钮高度:', box ? Math.round(box.height) : 'N/A', 'px', box && box.height < 50 ? 'OK（一行）' : 'FAIL（可能竖排）');
await page.screenshot({ path: 'accept/r7-save.png' });

// 3) 主题 pill 选项 + 分组标题
await page.goto(base + '/settings?section=preferences', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const themeBtns = await page.locator('button', { hasText: /^(浅色|暗黑|跟随系统)$/ }).count();
console.log('主题三态选项数:', themeBtns === 3 ? '3 OK' : `${themeBtns} FAIL`);
await page.screenshot({ path: 'accept/r7-theme.png' });

await page.goto(base + '/settings?section=categories', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'accept/r7-categories.png' });

// 4) 交易导入页面不再空白
await page.goto(base + '/transaction?import=1', { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const importBody = await page.textContent('body');
const hasUpload = importBody.includes('上传') && (importBody.includes('拖入') || importBody.includes('点击'));
console.log('导入页上传UI:', hasUpload ? 'PASS' : 'FAIL');
await page.screenshot({ path: 'accept/r7-import.png' });

console.log('PAGE_ERRORS:', JSON.stringify(errors.slice(0,5)));
await browser.close();