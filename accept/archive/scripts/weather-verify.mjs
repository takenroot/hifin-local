/**
 * 天气组件 stale-while-revalidate + 全国城市列表 自查
 * ---------------------------------------------------------------
 * 用法：node accept/scripts/weather-verify.mjs（需先在 5199 起 vite dev）
 * 覆盖：
 *  1. 缓存超期时先渲染 stale 值（标记"更新中"），回源成功后无感替换
 *  2. 外部天气 API 完全不可用时，缓存仍能立即渲染（证明 SWR 命中）
 *  3. 无缓存时显示城市名占位，不空白
 *  4. 城市弹窗：搜索框 + 可滚动列表 + 当前城市高亮 + 搜索"深"命中深圳 + 键盘选择
 */
import { chromium } from 'playwright';

const BASE = 'http://127.0.0.1:5199';
const API = 'http://127.0.0.1:8787';
const OUT = '/home/saltedfish/project/hifin/accept';
const HOUR = 3600 * 1000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function kvPut(key, value) {
  const r = await fetch(`${API}/api/kv/${key}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value }),
  });
  return r.status;
}
async function kvDel(key) {
  const r = await fetch(`${API}/api/kv/${key}`, { method: 'DELETE' });
  return r.status;
}
async function kvGet(key) {
  const r = await fetch(`${API}/api/kv/${key}`);
  if (!r.ok) return null;
  return (await r.json()).value;
}
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

const browser = await chromium.launch();
// permissions: [] → 浏览器定位被拒绝，走"用户选定城市"分支（且不会卡 3s）
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: [] });
const page = await ctx.newPage();
const errors = [];
// 主动制造的网络失败（kv 404 / 故意 abort 天气 API）不算页面错误
let expectNetworkErrors = false;
const isExpectedKvMiss = (t) => /Failed to load resource/.test(t) && /404/.test(t);
page.on('pageerror', (e) => errors.push(`pageerror: ${e}`));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (expectNetworkErrors || isExpectedKvMiss(t)) return;
  errors.push(`console: ${t}`);
});
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('/api/kv/')) {
    errors.push(`http ${r.status()}: ${r.url()}`);
  }
});

const summary = '[data-testid="weather-summary"]';
const readSummary = () => page.$eval(summary, (el) => el.innerText.replace(/\s+/g, ' ').trim());

try {
  /* ── 1. 缓存超期 → 先渲染 stale，再无感刷新 ───────────────────── */
  const now = Date.now();
  await kvDel('weather.city');
  await kvPut('weather.cache', {
    temperature: 18.2,
    weathercode: 0,
    cityName: '北京',
    lat: 39.9042,
    lon: 116.4074,
    fetchedAt: now - 3 * HOUR, // 3 小时前 → 超过 2 小时 TTL
  });

  // 放慢回源请求，确保 stale 状态可被稳定观测
  let slowed = false;
  await page.route('**/api.open-meteo.com/**', async (route) => {
    if (!slowed) {
      slowed = true;
      await new Promise((r) => setTimeout(r, 3000));
    }
    await route.continue();
  });

  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(summary, { timeout: 15000 });
  const staleText = await readSummary();
  check(
    '超期缓存先渲染（stale-while-revalidate 的 stale 半边）',
    staleText.includes('北京') && staleText.includes('°C') && !staleText.includes('--'),
    `首屏天气文案 = "${staleText}"`,
  );
  check('stale 数据标记"更新中"', staleText.includes('更新中'), `文案含"更新中…"`);
  await page.screenshot({ path: `${OUT}/weather-stale.png` });

  // 等回源完成
  await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return el && !el.innerText.includes('更新中');
      },
      summary,
      { timeout: 20000 },
    )
    .catch(() => {});
  const freshText = await readSummary();
  check('回源成功后无感替换', freshText.includes('°C') && !freshText.includes('--'), `刷新后文案 = "${freshText}"`);
  const cacheAfter = await kvGet('weather.cache');
  check(
    '回源写回缓存（fetchedAt 变为当前）',
    cacheAfter && Date.now() - cacheAfter.fetchedAt < 60 * 1000,
    `fetchedAt 距今 ${cacheAfter ? Math.round((Date.now() - cacheAfter.fetchedAt) / 1000) : '?'}s`,
  );
  await page.screenshot({ path: `${OUT}/weather-fresh.png` });

  /* ── 2. 外部 API 全部断掉，缓存仍立即渲染 ──────────────────── */
  await page.unroute('**/api.open-meteo.com/**');
  expectNetworkErrors = true;
  await page.route('**/api.open-meteo.com/**', (route) => route.abort());
  const t0 = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(summary, { timeout: 15000 });
  const hitText = await readSummary();
  const hitMs = Date.now() - t0;
  check(
    'Open-Meteo 不可用时仍从缓存渲染（零空白）',
    hitText.includes('°C') && !hitText.includes('--'),
    `"${hitText}"（${hitMs}ms 出现，外部 API 已 abort）`,
  );
  await page.screenshot({ path: `${OUT}/weather-cache-hit.png` });

  /* ── 3. 无缓存 → 城市名占位，不空白 ─────────────────────────── */
  await kvDel('weather.cache');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector(summary, { timeout: 15000 });
  const phText = await readSummary();
  check(
    '首次无缓存时显示城市占位（非空白）',
    phText.includes('北京') && phText.length > 0,
    `占位文案 = "${phText}"`,
  );
  await page.screenshot({ path: `${OUT}/weather-placeholder.png` });

  /* ── 4. 城市弹窗：搜索 + 滚动列表 + 高亮 + 键盘 ─────────────── */
  await page.unroute('**/api.open-meteo.com/**');
  expectNetworkErrors = false;
  await page.getByTitle('切换城市').click();
  await page.waitForSelector('[data-testid="city-search"]', { timeout: 5000 });

  const listInfo = await page.$eval('[data-testid="city-list"]', (el) => ({
    count: el.querySelectorAll('[role="option"]').length,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
    overflowY: getComputedStyle(el).overflowY,
  }));
  check('弹窗含搜索框', true, '已定位 [data-testid="city-search"]');
  check(
    '城市列表已扩充并可滚动',
    listInfo.count >= 60 && listInfo.scrollHeight > listInfo.clientHeight && listInfo.overflowY === 'auto',
    `${listInfo.count} 个城市，scrollHeight ${listInfo.scrollHeight} > clientHeight ${listInfo.clientHeight}（overflow-y: ${listInfo.overflowY}）`,
  );
  const currentMark = await page.$eval('[data-testid="city-list"] [aria-selected="true"]', (el) => el.innerText.trim());
  check('当前城市高亮', !!currentMark, `aria-selected 项 = "${currentMark.replace(/\s+/g, ' ')}"`);
  await page.screenshot({ path: `${OUT}/weather-city-modal.png` });

  // 搜索"深" → 只剩深圳
  await page.fill('[data-testid="city-search"]', '深');
  const hits = await page.$$eval('[data-testid="city-list"] [role="option"]', (els) =>
    els.map((e) => e.innerText.trim()),
  );
  check('搜索"深"过滤出深圳', hits.length === 1 && hits[0].startsWith('深圳'), `匹配结果 = ${JSON.stringify(hits)}`);
  await page.screenshot({ path: `${OUT}/weather-city-search.png` });

  // 键盘：Enter 选中高亮项
  await page.focus('[data-testid="city-list"]');
  await page.keyboard.press('Enter');
  await page.waitForFunction((sel) => !document.querySelector(sel), '[data-testid="city-search"]', { timeout: 5000 });
  const savedCity = await kvGet('weather.city');
  check('键盘 Enter 选中并落盘', savedCity && savedCity.name === '深圳', `kv weather.city = ${JSON.stringify(savedCity)}`);

  await page
    .waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        // 等真正抓到深圳的读数，而不是刚切过去的 "深圳 --°C" 占位
        return el && el.innerText.includes('深圳') && !el.innerText.includes('--');
      },
      summary,
      { timeout: 20000 },
    )
    .catch(() => {});
  const afterSwitch = await readSummary();
  check('切城市后天气变为深圳', afterSwitch.includes('深圳'), `文案 = "${afterSwitch}"`);
  const cacheCity = await kvGet('weather.cache');
  check('切城市后缓存已换成新城市坐标', cacheCity && cacheCity.cityName === '深圳', `cache.cityName = ${cacheCity?.cityName}`);
  await page.screenshot({ path: `${OUT}/weather-city-shenzhen.png` });

  check('无页面级 JS 报错', errors.length === 0, errors.slice(0, 3).join(' | ') || '无');
} catch (e) {
  check('脚本执行', false, String(e && e.message ? e.message : e));
} finally {
  // 还原环境：清除城市选择 + 预置一份新鲜的北京缓存
  await kvDel('weather.city');
  await kvPut('weather.cache', {
    temperature: 18.2,
    weathercode: 0,
    cityName: '北京',
    lat: 39.9042,
    lon: 116.4074,
    fetchedAt: Date.now(),
  });
  await browser.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n===== ${results.length - failed.length}/${results.length} 项通过 =====`);
if (failed.length) {
  for (const f of failed) console.log(`  FAIL: ${f.name} — ${f.detail}`);
  process.exit(1);
}
