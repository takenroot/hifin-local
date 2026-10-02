/**
 * tx-grouping-stats.mjs — 交易流水「日/周/月/年分组 + 统计 Tab」验收
 * ---------------------------------------------------------------
 * 覆盖需求与验收点：
 *   1. 流水列表四档分组各截图（日 / 周 / 月 / 年），分组头文案 + 周期小计
 *   2. 切到「月」档 → 刷新页面 → 断言仍是月档（atomWithStorage 持久性）
 *   3. 统计 Tab：月份翻页器（未来月禁用）、支出/收入 pill、饼图 + 分类排行
 *   4. 统计 Tab 翻到 2026-08 → 刷新页面 → 断言仍在 8 月（持久性）
 *   5. 所选月无数据 → EmptyStateCard
 *   6. 明暗双主题各跑一轮；全程无 console error / pageerror
 *
 * 数据策略（不污染 core 的 SQLite）：
 *   - 真实数据里 817 笔流水的 categoryId 全为 NULL，统计页只会渲染出单扇区
 *     「未分类」。为了让"饼图 + 排行"截图真实反映设计，脚本用 Playwright 路由
 *     拦截在**浏览器侧**给流水挂上真实分类 id 后再截图；core 侧全程只读。
 *   - 另存一组 `realdata` 截图，展示未经修饰的真身（单扇区「未分类」）。
 *
 * 用法：node accept/scripts/tx-grouping-stats.mjs
 *       BASE_URL=http://127.0.0.1:5189 node accept/scripts/tx-grouping-stats.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5189';
const API = process.env.CORE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = 'accept/screenshots/tx-grouping-stats';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(32)} ${detail}`);
}

/* ─────────────── 演示分类数据（仅浏览器侧，不写库） ─────────────── */

let DEMO_PAYLOAD = null;
async function demoPayload() {
  if (DEMO_PAYLOAD) return DEMO_PAYLOAD;
  const [txs, cats] = await Promise.all([
    fetch(`${API}/api/transactions`).then((r) => r.json()),
    fetch(`${API}/api/categories`).then((r) => r.json()),
  ]);
  const expenseIds = cats.filter((c) => c.type === 'expense').map((c) => c.id);
  const incomeIds = cats.filter((c) => c.type === 'income').map((c) => c.id);
  DEMO_PAYLOAD = txs.map((t, i) => {
    if (t.categoryId != null) return t;
    if (t.type === 'expense' && expenseIds.length) return { ...t, categoryId: expenseIds[i % expenseIds.length] };
    if (t.type === 'income' && incomeIds.length) return { ...t, categoryId: incomeIds[i % incomeIds.length] };
    return t;
  });
  return DEMO_PAYLOAD;
}

const DIMS = [
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'year', label: '年' },
];

async function newCtx(browser, theme, { mode = 'real' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(
    ([t]) => {
      localStorage.setItem('hifin:theme', JSON.stringify(t));
      localStorage.setItem('hifin:spaceId', '1');
    },
    [theme],
  );
  if (mode === 'empty') {
    await ctx.route('**/api/transactions*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );
  } else if (mode === 'demo') {
    const body = JSON.stringify(await demoPayload());
    await ctx.route('**/api/transactions*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body }),
    );
  }
  return ctx;
}

function watchErrors(page, bucket, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') bucket.push(`[${tag}] ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => bucket.push(`[${tag}] pageerror: ${String(e).slice(0, 160)}`));
}

async function openTx(page) {
  await page.goto(`${BASE}/transaction`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="tx-list"]', { timeout: 20000 });
  await page.waitForTimeout(500);
}

/** 统计 Tab 断言 + 截图：饼图扇区数、排行项数、排序、占比守恒 */
async function auditStats(page, month, tag) {
  const pie = await page.locator('[data-testid="stats-pie"] .recharts-pie-sector').count();
  const rank = await page.locator('[data-testid="stats-rank-item"]').count();
  record(`${tag} 饼图渲染`, pie > 0, `扇区 ${pie} 个`);
  record(`${tag} 排行渲染`, rank > 0, `排行 ${rank} 项`);
  if (rank === 0) return;
  const info = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('[data-testid="stats-rank-item"]'));
    const num = (el) => parseFloat((el?.textContent ?? '').replace(/[^\d.]/g, ''));
    return {
      pcts: items.map((el) => num(el.querySelector('[data-testid="stats-rank-pct"]'))),
      amounts: items.map((el) => num(el.querySelector('[data-testid="stats-rank-amount"]'))),
      first: items[0]?.innerText.replace(/\s+/g, ' ').trim() ?? '',
      last: items[items.length - 1]?.innerText.replace(/\s+/g, ' ').trim() ?? '',
    };
  });
  const desc = info.amounts.every((v, i, a) => Number.isFinite(v) && (i === 0 || a[i - 1] >= v));
  record(`${tag} 排行金额降序`, desc, `首「${info.first}」→ 末「${info.last}」`);
  const sum = info.pcts.reduce((a, b) => a + b, 0);
  // 每项展示保留 1 位小数，n 项累计误差上界 n*0.05
  record(
    `${tag} 占比合计 100%`,
    Math.abs(sum - 100) <= Math.max(0.5, info.pcts.length * 0.05),
    `${info.pcts.length} 项，逐项 1 位小数合计 ${sum.toFixed(2)}%`,
  );
}

async function gotoStatsMonth(page, month) {
  // 月份是全局持久化 atom，直接写 localStorage 再进 Tab，最稳也顺带验证持久化
  await page.evaluate((m) => localStorage.setItem('hifin:txStatsMonth', JSON.stringify(m)), month);
  await page.click('[data-testid="tx-view-tabs"] >> text=统计');
  await page.waitForSelector('[data-testid="tx-stats"]', { timeout: 20000 });
  await page.waitForTimeout(900);
  return (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
}

const browser = await chromium.launch();
const consoleErrors = [];

try {
  for (const theme of ['light', 'dark']) {
    console.log(`\n──── ${theme === 'light' ? '明亮' : '暗黑'}主题 ────`);

    /* ═══ A. 真实数据：四档分组 + 持久性 ═══ */
    {
      const ctx = await newCtx(browser, theme);
      const page = await ctx.newPage();
      watchErrors(page, consoleErrors, `${theme}/group`);

      await openTx(page);
      for (const d of DIMS) {
        await page.click(`[data-testid="tx-group-dim"] >> text=${d.label}`);
        await page.waitForTimeout(450);
        const activeDim = await page.getAttribute('[data-testid="tx-group-dim"]', 'data-dim');
        const heads = await page.locator('[data-testid="tx-group-head"] h3').allTextContents();
        const subtotals = await page.locator('[data-testid="tx-group-subtotal"]').count();
        const rows = await page.locator('[data-testid="tx-row"]').count();
        record(
          `${theme} ${d.label}档激活`,
          activeDim === d.key && heads.length > 0,
          `data-dim=${activeDim}，分组 ${heads.length} 组 / 明细 ${rows} 行`,
        );
        const sample = (heads[0] ?? '').trim();
        if (d.key === 'day') {
          const ok = subtotals === 0 && /^(今天|昨天|\d{4}年\d{1,2}月\d{1,2}日 \w{3})$/.test(sample);
          record(`${theme} 日档保持现状样式`, ok, `小计 ${subtotals} 个（应为 0），首组「${sample}」`);
        } else {
          const re =
            d.key === 'week'
              ? /^\d{4}年第\d{1,2}周（\d{1,2}\.\d{1,2}-\d{1,2}\.\d{1,2}）$/
              : d.key === 'month'
                ? /^\d{4}年\d{1,2}月$/
                : /^\d{4}年$/;
          const ok =
            subtotals === heads.length && re.test(sample) && heads.every((h) => re.test(h.trim()));
          record(`${theme} ${d.label}档分组头`, ok, `小计 ${subtotals}/${heads.length}，首组「${sample}」`);
          const st = subtotals
            ? (await page.locator('[data-testid="tx-group-subtotal"]').first().innerText()).replace(/\s+/g, ' ')
            : '';
          record(
            `${theme} ${d.label}档小计含收支额`,
            /支\s*¥\s*[\d,]+\.\d{2}\s*·\s*收\s*¥\s*[\d,]+\.\d{2}/.test(st),
            st,
          );
        }
        await page.screenshot({ path: `${SHOTS}/group-${d.key}-${theme}.png`, fullPage: false });
      }

      // 分段控件选中块必须与容器底色不同（暗色下最容易同色失效）
      const seg = await page.evaluate(() => {
        const active = document.querySelector('[data-testid="tx-group-dim"] [aria-selected="true"]');
        const box = document.querySelector('[data-testid="tx-group-dim"] [role="tablist"]');
        return {
          label: active?.innerText.trim() ?? '',
          activeBg: active ? getComputedStyle(active).backgroundColor : null,
          boxBg: box ? getComputedStyle(box).backgroundColor : null,
        };
      });
      record(
        `${theme} 分段控件选中态可见`,
        seg.label === '年' && seg.activeBg && seg.activeBg !== seg.boxBg,
        `选中「${seg.label}」底色 ${seg.activeBg} vs 容器 ${seg.boxBg}`,
      );

      // 分组档位刷新持久性
      await page.click('[data-testid="tx-group-dim"] >> text=月');
      await page.waitForTimeout(300);
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="tx-list"]', { timeout: 20000 });
      await page.waitForTimeout(500);
      const dim = await page.getAttribute('[data-testid="tx-group-dim"]', 'data-dim');
      const lsDim = await page.evaluate(() => localStorage.getItem('hifin:txGroupDim'));
      record(
        `${theme} 月档刷新后保持`,
        dim === 'month' && String(lsDim).includes('month'),
        `刷新后 data-dim=${dim}，localStorage=${lsDim}`,
      );
      await page.screenshot({ path: `${SHOTS}/group-month-persist-${theme}.png`, fullPage: false });

      if (theme === 'dark') {
        const t = await page.evaluate(() => {
          const card = document.querySelector('[data-testid="tx-list"] .card');
          const head = document.querySelector('[data-testid="tx-group-head"] h3');
          const sub = document.querySelector('[data-testid="tx-group-subtotal"]');
          return {
            htmlDark: document.documentElement.classList.contains('dark'),
            cardBg: card ? getComputedStyle(card).backgroundColor : null,
            headColor: head ? getComputedStyle(head).color : null,
            subColor: sub ? getComputedStyle(sub).color : null,
          };
        });
        record(
          '暗色 语义 token 成双',
          t.htmlDark && t.cardBg === 'rgb(23, 26, 33)' && t.headColor === 'rgb(229, 231, 235)',
          `html.dark=${t.htmlDark} 卡片底=${t.cardBg} 标题=${t.headColor} 小计=${t.subColor}`,
        );
      }
      await ctx.close();
    }

    /* ═══ B. 真实数据：统计 Tab（月份翻页 / 未来月禁用 / 持久性） ═══ */
    {
      const ctx = await newCtx(browser, theme);
      const page = await ctx.newPage();
      watchErrors(page, consoleErrors, `${theme}/stats`);

      await openTx(page);
      await page.click('[data-testid="tx-view-tabs"] >> text=统计');
      await page.waitForSelector('[data-testid="tx-stats"]', { timeout: 20000 });
      await page.waitForTimeout(900);

      const nowLabel = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
      const nextDisabled = await page.locator('[data-testid="stats-next-month"]').isDisabled();
      const activeType = (await page.locator('[data-testid="stats-type-toggle"] [aria-selected="true"]').first().innerText()).trim();
      record(`${theme} 统计默认当前月`, /^\d{4}年\d{1,2}月$/.test(nowLabel), `「${nowLabel}」`);
      record(`${theme} 未来月禁用`, nextDisabled, `当前月「›」disabled=${nextDisabled}`);
      record(`${theme} 统计默认支出`, activeType.includes('支出'), `「${activeType}」`);

      // 翻页器：连续回翻直到 2026-09
      for (let i = 0; i < 12; i++) {
        const label = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
        if (label === '2026年9月') break;
        await page.click('[data-testid="stats-prev-month"]');
        await page.waitForTimeout(220);
      }
      const sep = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
      record(`${theme} 月份可回翻`, sep === '2026年9月', `从「${nowLabel}」翻到「${sep}」`);

      await page.click('[data-testid="stats-prev-month"]');
      await page.waitForTimeout(800);
      const aug = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
      record(`${theme} 翻到2026-08`, aug === '2026年8月', `「${aug}」`);
      await page.screenshot({ path: `${SHOTS}/stats-realdata-2026-08-${theme}.png`, fullPage: false });

      // 刷新后重新进入统计 Tab（视图本身不入 URL），月份必须仍是 2026-08
      await page.reload({ waitUntil: 'networkidle' });
      await page.waitForSelector('[data-testid="tx-list"]', { timeout: 20000 });
      await page.click('[data-testid="tx-view-tabs"] >> text=统计');
      await page.waitForSelector('[data-testid="tx-stats"]', { timeout: 20000 });
      await page.waitForTimeout(900);
      const augAfter = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
      const lsMonth = await page.evaluate(() => localStorage.getItem('hifin:txStatsMonth'));
      record(
        `${theme} 统计月刷新后保持`,
        augAfter === '2026年8月' && String(lsMonth).includes('2026-08'),
        `刷新后「${augAfter}」，localStorage=${lsMonth}`,
      );
      await page.screenshot({ path: `${SHOTS}/stats-2026-08-persist-${theme}.png`, fullPage: false });
      await ctx.close();
    }

    /* ═══ C. 演示分类数据：饼图 + 排行主截图（仅浏览器侧注入，不写库） ═══ */
    {
      const ctx = await newCtx(browser, theme, { mode: 'demo' });
      const page = await ctx.newPage();
      watchErrors(page, consoleErrors, `${theme}/stats-demo`);

      await openTx(page);
      const l1 = await gotoStatsMonth(page, '2026-09');
      record(`${theme} 统计2026-09`, l1 === '2026年9月', `「${l1}」`);
      await auditStats(page, '2026-09', `${theme} 2026-09支出`);
      await page.screenshot({ path: `${SHOTS}/stats-expense-${theme}.png`, fullPage: false });

      await page.click('[data-testid="stats-type-toggle"] >> text=收入');
      await page.waitForTimeout(900);
      const t2 = (await page.locator('[data-testid="stats-type-toggle"] [aria-selected="true"]').first().innerText()).trim();
      record(`${theme} 收入档生效`, t2.includes('收入'), `「${t2}」`);
      await auditStats(page, '2026-09', `${theme} 2026-09收入`);
      await page.screenshot({ path: `${SHOTS}/stats-income-${theme}.png`, fullPage: false });

      await page.click('[data-testid="stats-type-toggle"] >> text=支出');
      await page.waitForTimeout(600);
      const l3 = await page.locator('[data-testid="stats-month-label"]').innerText();
      void l3;
      await page.click('[data-testid="stats-prev-month"]'); // -> 2026-08
      await page.waitForTimeout(800);
      const l4 = (await page.locator('[data-testid="stats-month-label"]').innerText()).trim();
      record(`${theme} 翻页到2026-08`, l4 === '2026年8月', `「${l4}」`);
      await auditStats(page, '2026-08', `${theme} 2026-08支出`);
      await page.screenshot({ path: `${SHOTS}/stats-2026-08-${theme}.png`, fullPage: false });
      await ctx.close();
    }

    /* ═══ D. 空月 → EmptyStateCard ═══ */
    {
      const ctx = await newCtx(browser, theme, { mode: 'empty' });
      const page = await ctx.newPage();
      watchErrors(page, consoleErrors, `${theme}/stats-empty`);
      await page.goto(`${BASE}/transaction?import=1`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(400);
      await page.click('[data-testid="tx-view-tabs"] >> text=统计');
      await page.waitForSelector('[data-testid="tx-stats"]', { timeout: 20000 });
      await page.waitForTimeout(800);
      const n = await page.locator('div.max-w-2xl.mx-auto > div.card').count();
      const txt = n
        ? (await page.locator('div.max-w-2xl.mx-auto > div.card').first().innerText()).replace(/\s+/g, ' ')
        : '';
      record(`${theme} 统计空月用EmptyStateCard`, n === 1, txt.slice(0, 48));
      await page.screenshot({ path: `${SHOTS}/stats-empty-${theme}.png`, fullPage: false });
      await ctx.close();
    }
  }

  record('无 console / page 报错', consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '0 条');
} catch (e) {
  record('脚本执行', false, String(e).slice(0, 300));
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log('\n=========== 汇总 ===========');
console.log(`断言总数: ${results.length}   通过: ${results.length - failed.length}   失败: ${failed.length}`);
if (failed.length) {
  for (const f of failed) console.log(`  - ${f.name} · ${f.detail}`);
}
console.log(`截图目录: ${SHOTS}/`);
process.exit(failed.length === 0 ? 0 : 1);
