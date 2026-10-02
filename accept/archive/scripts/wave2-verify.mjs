import { chromium } from 'playwright';
const base = 'http://127.0.0.1:5199';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e).slice(0,200)));

const pages = [
  ['/home', 'home'], ['/account/list', 'accounts'], ['/transaction', 'transactions'],
  ['/goal/list', 'goals'], ['/report/list', 'reports'], ['/budget', 'budget'],
  ['/discover', 'discover'], ['/settings', 'settings'], ['/ai', 'ai'],
];
let pass = 0, fail = 0;
for (const [path, name] of pages) {
  await page.goto(base + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const text = await page.textContent('body');
  const hasData = text.length > 100;
  const err = errors.length > 0 ? errors[errors.length-1] : '';
  const ok = hasData && !err;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} bodyLen=${text.length} ${err ? 'ERR:'+err.slice(0,80) : ''}`);
  ok ? pass++ : fail++;
  await page.screenshot({ path: `accept/wave2-${name}.png` });
}
console.log(`=== ${pass} pass, ${fail} fail ===`);
console.log('ALL_ERRORS:', JSON.stringify(errors.slice(0,5)));
await browser.close();
