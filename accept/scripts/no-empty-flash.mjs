/**
 * no-empty-flash.mjs — 列表页「先闪空状态再出数据」回归
 * ---------------------------------------------------------------------------
 * 复现路径：列表页首帧 useApi 的 data=null、loading=true，而空状态只看 count===0，
 * 于是每次进页面都会先渲染一帧 EmptyStateCard / 「暂无」，数据到达后再换成列表。
 *
 * 判定手段：用 page.route() 把 /api/* 统一延迟 800ms（等价于慢网/冷启动），
 * 并在页面里挂一个 rAF 探针——rAF 回调发生在 paint 之前，逐帧采样 DOM，
 * 只要有任何一帧画出空态就会被记下（比轮询可靠，不会漏掉亚帧闪现）。
 * 探针用 Date.now()，与 Node 侧同一时钟域，因此可以拿 route 放行时刻当「加载结束」的分界线。
 *
 * 为什么用 route 延迟而不是 CDP 限速：CDP 只能给一个模糊的慢网，
 * 拿不到「这份数据具体什么时候回来的」；而本脚本的断言 1 恰恰是
 * 「空态出现的时间必须晚于主数据请求放行的时间」，需要这个精确边界。
 *
 * 覆盖两组场景：
 *   A. 冷启动（page.goto，模块级缓存为空）→ 加载期间不得出现空态 / 「暂无」
 *   B. 二次访问（侧边栏客户端路由来回切，模块级缓存仍在）→ 首帧即有数据，
 *      即在 800ms 延迟窗口内就settle，证明数据来自 useApi 的 SWR 缓存而非网络
 *
 * 另有一条合成数据用例：库里的预算确实是空的（count=0），单靠真实数据无法验证
 * 「有数据时列表正常渲染」，故用 route mock 塞一条预算，零写入地跑通该路径。
 */
import { chromium } from '/home/saltedfish/project/hifin/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const BASE = process.env.HIFIN_BASE || 'http://127.0.0.1:5186';
const DELAY = Number(process.env.ROUTE_DELAY_MS || 800);
const AWAY = '/home';
const OUT = 'accept/screenshots/no-empty-flash';
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 三个受检列表页。primary = 该页列表自己的主数据端点，充当「加载结束」分界线 */
const PAGES = [
  {
    name: '交易流水',
    path: '/transaction',
    primary: /\/api\/transactions(\?|$)/,
    contentSel: '[data-testid="tx-row"]',
    afterLoad: 'content',
  },
  {
    name: '账户列表',
    path: '/account/list',
    primary: /\/api\/accounts(\?|$)/,
    contentSel: '[data-testid="account-card"]',
    afterLoad: 'content',
  },
  {
    name: '预算列表',
    path: '/budget',
    primary: /\/api\/budgets(\?|$)/,
    contentSel: '[data-testid="budget-card"]',
    // 库里确实一条预算都没有，加载完成后出现空态是正确行为（不是 flash）
    afterLoad: 'empty',
  },
];

/**
 * 探针：逐帧采样 <main>，记录空态 / 「暂无」/ 列表内容首次出现的墙钟时刻。
 *
 * 两个容易误判的点，这里都处理了：
 * 1. 只在**受检路由**上记录 —— 切离时用的 /home 看板本来就常驻「暂无待还款」
 *    这类文案，那是它自己的正确行为，不能算到被测页头上；
 * 2. ecOn / zOn（当前是否已处于该状态）**始终**更新、不受受检路由限制 ——
 *    否则「pushState 已换 URL、React 还没提交 DOM」那一帧，会把上一页的既有
 *    文案记成一次新事件。记录按受检路由过滤，状态跟踪走全局，是有意为之。
 */
const PROBE_SRC = `
(() => {
  const WATCH = ${JSON.stringify(PAGES.map((p) => p.path))};
  const SEL = ${JSON.stringify(Object.fromEntries(PAGES.map((p) => [p.path, p.contentSel])))};

  const vis = (el) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.01;
  };
  const mainOf = () => document.querySelector('main') || document.body;

  function sample() {
    const p = window.__probe;
    if (!p) return;
    const m = mainOf();
    if (!m) return;
    const t = Date.now();

    // EmptyStateCard 的固定容器
    const hasEc = vis(m.querySelector('.max-w-2xl.mx-auto'));

    // 「暂无」文案：textContent 粗筛（不触发布局），innerText 复核（排除 display:none）
    let hasZ = false;
    if ((m.textContent || '').includes('暂无')) {
      try { hasZ = (m.innerText || '').includes('暂无'); } catch (e) { hasZ = true; }
    }

    if (WATCH.indexOf(location.pathname) >= 0) {
      if (hasEc && !p.ecOn) p.ecAt.push(t);
      if (hasZ && !p.zOn) p.zAt.push(t);
      if (p.ecFirst === null && hasEc) p.ecFirst = t;
      // 列表内容首次出现 = SWR 缓存命中的判据
      const sel = SEL[location.pathname];
      if (p.contentAt === null && sel && vis(m.querySelector(sel))) p.contentAt = t;
    }

    // 状态跟踪始终更新（见上方注释 2）
    p.ecOn = hasEc;
    p.zOn = hasZ;
  }

  if (!window.__probeLoop) {
    window.__probeLoop = true;
    const loop = () => { sample(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  window.__resetProbe = () => {
    window.__probe = { ecAt: [], zAt: [], ecFirst: null, contentAt: null, ecOn: false, zOn: false };
    sample();
  };
  if (!window.__probe) window.__resetProbe();
})();
`;

/** 合成预算：只用于「有数据时列表正常渲染」这条断言，不落库 */
const FAKE_BUDGET = {
  id: 900001,
  name: '__flash_probe__',
  amount: 1000,
  period: 'monthly',
  categoryId: null,
  spaceId: 1,
  createdAt: 1,
  updatedAt: 1,
};

const fulfillLog = [];
let mockBudgets = false;

const results = [];
let failures = 0;

function record(name, checks) {
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) failures++;
  results.push({ 用例: name, 结果: bad.length === 0 ? 'PASS' : 'FAIL', 检查: checks });
}

/** 等到该页「数据到位」：有内容的页等列表行，空数据的页等空态卡片 */
function waitSettled(page, cfg, timeout = 30000) {
  return page.waitForFunction(
    (a) => {
      const m = document.querySelector('main') || document.body;
      if (!m) return false;
      const vis = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      if (a.expect === 'content' && vis(m.querySelector(a.sel))) return true;
      if (a.expect === 'empty' && vis(m.querySelector('.max-w-2xl.mx-auto'))) return true;
      return false;
    },
    { expect: cfg.afterLoad, sel: cfg.contentSel },
    { timeout },
  );
}

/** 客户端路由跳转（点侧边栏），保住 JS 模块 → 保住 useApi 的模块级缓存 */
async function clickNav(page, path) {
  const link = page.locator(`a[href="${path}"]:visible`).first();
  await link.waitFor({ state: 'visible', timeout: 10000 });
  await link.click();
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(PROBE_SRC);

await ctx.route('**/api/**', async (route) => {
  const url = route.request().url();
  const isBudgets = /\/api\/budgets(\?|$)/.test(url);
  await sleep(DELAY);
  const at = Date.now();
  fulfillLog.push({ url, at });  if (isBudgets && mockBudgets) {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([FAKE_BUDGET]),
    });
  } else {
    await route.continue();
  }
});

/* ── A. 冷启动：整页加载，模块缓存为空 ─────────────────────────────── */
for (const cfg of PAGES) {
  fulfillLog.length = 0;
  const page = await ctx.newPage();
  await page.goto(BASE + cfg.path, { waitUntil: 'commit' });
  // 延迟窗口内抓一张，确认加载态不是空态
  await page.waitForTimeout(Math.round(DELAY * 0.4));
  await page.screenshot({ path: `${OUT}/cold-loading${cfg.path.replace(/\//g, '-')}.png` });

  await waitSettled(page, cfg);
  await page.waitForTimeout(500);
  const probe = await page.evaluate(() => window.__probe);
  const shot = await page.screenshot({ path: `${OUT}/cold-loaded${cfg.path.replace(/\//g, '-')}.png` });
  void shot;

  // 该页主数据的放行时刻 = 「加载结束」分界线
  const primaryAt = fulfillLog.filter((f) => cfg.primary.test(f.url)).map((f) => f.at).sort((a, b) => a - b)[0];
  const beforeLoad = (arr) => (primaryAt == null ? arr : arr.filter((t) => t < primaryAt));

  const ecDuring = beforeLoad(probe.ecAt);
  const zDuring = beforeLoad(probe.zAt);
  const finalEc = probe.ecFirst != null;
  const finalContent = probe.contentAt != null;

  record(`A 冷启动 ${cfg.name} ${cfg.path}`, [
    { 项: '加载期间不出现 EmptyStateCard (.max-w-2xl.mx-auto)', ok: ecDuring.length === 0, 实测: `${ecDuring.length} 帧 @ ${JSON.stringify(ecDuring)}`, 边界: primaryAt },
    { 项: '加载期间不出现「暂无」文案', ok: zDuring.length === 0, 实测: `${zDuring.length} 次 @ ${JSON.stringify(zDuring)}`, 边界: primaryAt },
    cfg.afterLoad === 'content'
      ? { 项: '数据到达后列表正常渲染', ok: finalContent, 实测: finalContent ? `内容首现 ${probe.contentAt}` : '未出现列表行' }
      : { 项: '数据到达后展示空态（该页本就无数据）', ok: finalEc, 实测: finalEc ? `空态首现 ${probe.ecFirst}` : '未出现空态' },
  ]);

  await page.close();
}

/* ── B. 二次访问：侧边栏来回切，模块缓存仍在 ─────────────────────── */
for (const cfg of PAGES) {
  const page = await ctx.newPage();
  await page.goto(BASE + cfg.path, { waitUntil: 'commit' });
  await waitSettled(page, cfg);
  await page.waitForTimeout(600);

  // 切到别的页（客户端路由），确认 useApi 模块没被卸载 → 缓存还在
  await clickNav(page, AWAY);
  await page.waitForTimeout(1800);

  fulfillLog.length = 0;
  await page.evaluate(() => window.__resetProbe());
  const t0 = Date.now();
  await clickNav(page, cfg.path);
  await waitSettled(page, cfg, 15000);
  await page.waitForTimeout(300);
  const probe = await page.evaluate(() => window.__probe);
  await page.screenshot({ path: `${OUT}/warm${cfg.path.replace(/\//g, '-')}.png` });

  const settledAt = cfg.afterLoad === 'content' ? probe.contentAt : probe.ecFirst;
  const elapsed = settledAt == null ? null : settledAt - t0;
  // 只看切回之后的采样
  const zAfter = probe.zAt.filter((t) => t >= t0);
  const ecAfter = probe.ecAt.filter((t) => t >= t0);

  // 必须等后台 revalidate 真的落地，才能拿到「网络放行时刻」这个证据；
  // 提前读会拿到空的 fulfillLog，断言就退化成只比 DELAY，失去了证明力。
  await page.waitForTimeout(DELAY + 800);
  const primaryAt = fulfillLog.filter((f) => cfg.primary.test(f.url)).map((f) => f.at).sort((a, b) => a - b)[0];
  // 数据「本该」在 800ms 后才到：若 settle 早于网络放行，说明首帧数据来自 SWR 缓存
  const beforeNetwork =
    elapsed != null && primaryAt != null && settledAt < primaryAt && elapsed < DELAY;

  record(`B 二次访问 ${cfg.name} ${cfg.path}`, [
    {
      项: `切回后首帧即有数据（settle 用时 < 延迟 ${DELAY}ms）`,
      ok: beforeNetwork,
      实测: elapsed == null ? '未 settle' : `${elapsed}ms（网络放行在 ${primaryAt == null ? 'n/a' : primaryAt - t0}ms）`,
    },
    { 项: '切回期间不出现「暂无」文案', ok: zAfter.length === 0, 实测: `${zAfter.length} 次 @ ${JSON.stringify(zAfter)}` },
    cfg.afterLoad === 'content'
      ? { 项: '切回期间不出现 EmptyStateCard', ok: ecAfter.length === 0, 实测: `${ecAfter.length} 次 @ ${JSON.stringify(ecAfter)}` }
      : { 项: '切回后仍正确展示空态', ok: ecAfter.length > 0, 实测: `${ecAfter.length} 次` },
  ]);

  await page.close();
}

/* ── C. 合成数据：有数据时列表正常渲染（预算库真实为空，零写入覆盖） ── */
{
  const cfg = PAGES.find((p) => p.path === '/budget');
  mockBudgets = true;
  const page = await ctx.newPage();
  fulfillLog.length = 0;
  await page.goto(BASE + cfg.path, { waitUntil: 'commit' });
  await page.waitForTimeout(Math.round(DELAY * 0.4));
  await page.screenshot({ path: `${OUT}/mock-loading-budget.png` });

  await waitSettled(page, { ...cfg, afterLoad: 'content' });
  await page.waitForTimeout(400);
  const probe = await page.evaluate(() => window.__probe);
  await page.screenshot({ path: `${OUT}/mock-loaded-budget.png` });

  const primaryAt = fulfillLog.filter((f) => cfg.primary.test(f.url)).map((f) => f.at).sort((a, b) => a - b)[0];
  const ecDuring = probe.ecAt.filter((t) => t < primaryAt);
  const zDuring = probe.zAt.filter((t) => t < primaryAt);

  record('C 合成预算（有数据路径） /budget', [
    { 项: '加载期间不出现 EmptyStateCard', ok: ecDuring.length === 0, 实测: `${ecDuring.length} 帧`, 边界: primaryAt },
    { 项: '加载期间不出现「暂无」文案', ok: zDuring.length === 0, 实测: `${zDuring.length} 次`, 边界: primaryAt },
    { 项: '数据到达后预算卡片正常渲染', ok: probe.contentAt != null, 实测: probe.contentAt != null ? `卡片首现 ${probe.contentAt}` : '未渲染卡片' },
  ]);

  mockBudgets = false;
  await page.close();
}

await browser.close();
console.log(
  JSON.stringify(
    { meta: { base: BASE, delayMs: DELAY, away: AWAY }, 失败用例数: failures, summary: results },
    null,
    2,
  ),
);
process.exit(failures === 0 ? 0 : 1);
