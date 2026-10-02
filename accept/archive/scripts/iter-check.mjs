import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,150)));
page.on('console', m => { if (m.type()==='error') errors.push(m.text().slice(0,150)); });

// 预算页
await page.goto(base + '/budget', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const budgetText = await page.textContent('body');
console.log('预算页:', budgetText.includes('创建预算') || budgetText.includes('预算') ? 'PASS' : 'FAIL');
await page.screenshot({ path: 'accept/iter-budget.png' });

// 交易规则
await page.goto(base + '/settings?section=rules', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const rulesText = await page.textContent('body');
console.log('交易规则页:', (rulesText.includes('规则') && !rulesText.includes('占位')) ? 'PASS' : 'FAIL', '| 含新建规则:', rulesText.includes('新建规则') || rulesText.includes('关键词'));
await page.screenshot({ path: 'accept/iter-rules.png' });

// AI 助手（未配置模型应显示引导，不报错）
await page.goto(base + '/ai', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const aiText = await page.textContent('body');
console.log('AI助手页:', (aiText.includes('配置') || aiText.includes('模型')) ? 'PASS' : 'FAIL');
await page.screenshot({ path: 'accept/iter-ai.png' });

// 空状态新插画（账户页）
await page.goto(base + '/account/list', { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'accept/iter-emptystate.png' });

// 侧边栏预算入口
await page.goto(base + '/home', { waitUntil: 'networkidle' });
await page.waitForTimeout(600);
const homeText = await page.textContent('body');
console.log('侧边栏预算入口:', homeText.includes('预算') ? 'PASS' : 'FAIL');

console.log('PAGE_ERRORS:', JSON.stringify(errors.slice(0,5)));
await browser.close();
