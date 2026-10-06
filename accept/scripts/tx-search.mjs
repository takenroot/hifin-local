/**
 * tx-search.mjs — 交易流水「关键字搜索」验收
 * ---------------------------------------------------------------
 * 覆盖需求与验收点：
 *   1. 搜索框常驻列表顶部，初始为空
 *   2. 搜「蜜雪」过滤出对应若干笔，行数与 API 推导一致
 *   3. 每一条命中行都确实包含关键字（没有"漏网的"）
 *   4. 「共 N 笔」计数跟着关键字走，合计卡（收入/支出/数量）同样跟随
 *   5. 输入防抖 200ms：输入后立刻不生效，停手 ~250ms 才过滤
 *   6. 匹配范围覆盖 name / 分类名 / 备注，且不区分大小写
 *   7. trim 后为空 = 不过滤
 *   8. 无命中时进空态，但搜索框必须还在（能原地清空）
 *   9. × 清空按钮恢复全量
 *  10. 关键字不持久化：刷新后搜索框回到空
 *  11. 与顶部筛选叠加（类型=支出 ∩ 关键字）
 *  12. 与分组维度正交：切 日/周/月/年 命中数不变
 *  13. 移动端 390px 不挤爆（无横向滚动、搜索框不溢出）
 *  14. 明暗双主题各跑一轮，全程无 console error / pageerror
 *
 * 数据策略：core 全程只读，期望值全部从 :8787 现算，脚本里不写死任何业务数字。
 *
 * 用法：node accept/scripts/tx-search.mjs
 *       BASE_URL=http://127.0.0.1:5185 node accept/scripts/tx-search.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5185';
const API = process.env.CORE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = 'accept/screenshots/tx-search';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
}

/* ─────────────── 错误采集 ─────────────── */

const consoleErrors = [];
const failedReqs = [];
function watchErrors(page, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 160)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failedReqs.push(`[${tag}] HTTP ${r.status()} ${r.url()}`);
  });
}

/* ─────────────── 从 API 推导期望值（不写死业务数字） ─────────────── */

const SPACE_ID = 1; // 与下面 initScript 写入的 hifin:spaceId 保持一致

const [txRows, cats, merchs] = await Promise.all([
  fetch(`${API}/api/transactions`).then((r) => r.json()),
  fetch(`${API}/api/categories`).then((r) => r.json()),
  fetch(`${API}/api/merchants`).then((r) => r.json()),
]);
const catName = new Map(cats.map((c) => [c.id, c.name]));
const merchName = new Map(merchs.map((m) => [m.id, m.name]));

/** 与 app 侧 filterBySpace 同口径：缺 spaceId 视为默认空间 1 */
const scoped = txRows.filter((t) => (t.spaceId ?? 1) === SPACE_ID);

/** 与 txMatchesKeyword 同口径：name / 分类名 / 商户名 / remark，不区分大小写 */
function hitsOf(kw) {
  const k = kw.trim().toLowerCase();
  if (!k) return scoped;
  return scoped.filter((t) =>
    [t.name, catName.get(t.categoryId), merchName.get(t.merchantId), t.remark].some(
      (s) => typeof s === 'string' && s.toLowerCase().includes(k),
    ),
  );
}
const sumOf = (list, type) =>
  list.reduce((s, t) => (t.type === type && t.includeInAsset !== false ? s + t.amount : s), 0);

/* 关键字一：挑一个在数据里真实存在的商户名片段 */
const KW = [...new Set(scoped.map((t) => t.name || ''))].find((n) => n.includes('蜜雪')) ?? '蜜雪';
const KW_EXPECT = hitsOf(KW);

/* 关键字二：分类名（证明"按分类名也能搜"，而不只是按 name） */
const KW_CAT = [...new Set([...catName.values()])]
  .sort((a, b) => hitsOf(b).length - hitsOf(a).length)[0];
const KW_CAT_EXPECT = hitsOf(KW_CAT);

/* 关键字三：一个大小写混排的拉丁串，用来验不区分大小写 */
const MIXED = scoped
  .map((t) => t.name || '')
  .find((n) => /^[A-Za-z0-9 .()\-]+$/.test(n) && /[a-z]/.test(n) && /[A-Z]/.test(n));
const KW_CASE = (MIXED?.match(/[A-Za-z]{4,}/) ?? ['Steam'])[0];
const KW_UPPER = KW_CASE.toUpperCase();
const KW_CASE_EXPECT = hitsOf(KW_CASE);

/* 关键字四：一定搜不到的串 */
const KW_NONE = '不存在的关键字zzz';

console.log(
  `期望值（API 推导）：空间 ${SPACE_ID} 共 ${scoped.length} 笔\n` +
    `  「${KW}」→ ${KW_EXPECT.length} 笔（收 ${sumOf(KW_EXPECT, 'income').toFixed(2)} / 支 ${sumOf(KW_EXPECT, 'expense').toFixed(2)}）\n` +
    `  分类名「${KW_CAT}」→ ${KW_CAT_EXPECT.length} 笔\n` +
    `  大小写「${KW_CASE}」/「${KW_UPPER}」→ ${KW_CASE_EXPECT.length} 笔\n` +
    `  类型=支出 ∩ 「${KW}」→ ${hitsOf(KW).filter((t) => t.type === 'expense').length} 笔\n`,
);

/* ─────────────── 页面辅助 ─────────────── */

async function newCtx(browser, theme, viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  // 注意：initScript 的函数体在浏览器里执行，闭包变量取不到，
  // 所有需要的数据都必须通过第 2 个参数传进去
  await ctx.addInitScript(
    ([t, s, dirty]) => {
      localStorage.setItem('hifin:theme', JSON.stringify(t));
      localStorage.setItem('hifin:spaceId', String(s));
      // 关键字按需求不持久化：埋一个脏残留，误读它的实现应当被无视
      localStorage.setItem('hifin:txKeyword', JSON.stringify(dirty));
    },
    [theme, SPACE_ID, KW_NONE],
  );
  return ctx;
}

async function openTx(page) {
  await page.goto(`${BASE}/transaction`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="tx-search"]', { timeout: 25000 });
  await page.waitForSelector('[data-testid="tx-row"]', { timeout: 25000 });
  await page.waitForTimeout(600);
}

const rows = (page) => page.locator('[data-testid="tx-row"]').count();
const rowTexts = (page) =>
  page.locator('[data-testid="tx-row"]').allInnerTexts().then((t) => t.map((s) => s.replace(/\s+/g, ' ')));
const searchBox = (page) => page.locator('[data-testid="tx-search"]');
/** 「共 N 笔」里的 N */
const countText = (page) =>
  page.locator('[data-testid="tx-count"]').innerText().then((t) => {
    const m = t.match(/共\s*([\d,]+)\s*笔/);
    return m ? Number(m[1].replace(/,/g, '')) : NaN;
  });
/** 合计卡「收入 / 支出」两格（数量由工具条「共 N 笔」承载，不重复展示） */
const sumCards = (page) =>
  page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('[data-testid="tx-list"] > div.grid > div.card')) {
      const label = el.firstElementChild?.textContent?.trim() ?? '';
      const value = el.lastElementChild?.textContent?.trim() ?? '';
      out[label] = value;
    }
    return out;
  });

/** 输入关键字并等防抖过去 */
async function typeKeyword(page, kw) {
  await searchBox(page).fill(kw);
  await page.waitForTimeout(450); // > KEYWORD_DEBOUNCE_MS(200)
}

const browser = await chromium.launch();

try {
  for (const theme of ['light', 'dark']) {
    console.log(`──── ${theme === 'light' ? '明亮' : '暗黑'}主题 ────`);
    const ctx = await newCtx(browser, theme);
    const page = await ctx.newPage();
    watchErrors(page, theme);

    /* ═══ 1. 搜索框常驻 + 未搜索时全量 ═══ */
    await openTx(page);
    const initial = await searchBox(page).inputValue();
    const allRows = await rows(page);
    record(
      `${theme} 搜索框常驻且初始为空`,
      initial === '' && allRows === scoped.length,
      `输入框「${initial}」，全量 ${allRows} 行（API ${scoped.length}）`,
    );

    /* ═══ 2. 输入「蜜雪」→ 过滤 + 计数跟随 ═══ */
    await typeKeyword(page, KW);
    const hitRows = await rows(page);
    record(
      `${theme} 「${KW}」过滤出 ${KW_EXPECT.length} 笔`,
      hitRows === KW_EXPECT.length && hitRows > 0,
      `渲染 ${hitRows} 行，API 推导 ${KW_EXPECT.length} 行`,
    );
    const texts = await rowTexts(page);
    record(
      `${theme} 命中行都含关键字`,
      texts.length > 0 && texts.every((t) => t.includes(KW)),
      `抽查 ${Math.min(texts.length, 3)}/${texts.length} 行首部「${texts[0]?.slice(0, 24)}…」`,
    );
    const cnt = await countText(page);
    const sums = await sumCards(page);
    record(
      `${theme} 「共 N 笔」跟着关键字走`,
      cnt === KW_EXPECT.length,
      `「共 ${cnt} 笔」（期望 ${KW_EXPECT.length}）`,
    );
    record(
      `${theme} 合计卡跟随关键字`,
      sums['收入'] === `¥ ${sumOf(KW_EXPECT, 'income').toFixed(2)}` &&
        sums['支出'] === `¥ ${sumOf(KW_EXPECT, 'expense').toFixed(2)}` &&
        !('数量' in sums),
      `收 ${sums['收入']} / 支 ${sums['支出']}（数量卡已移除，计数在「共 N 笔」）`,
    );
    await page.screenshot({ path: `${SHOTS}/hit-${theme}.png` });

    /* ═══ 3. 200ms 防抖 ═══ */
    await searchBox(page).fill('');
    await page.waitForTimeout(400);
    await searchBox(page).fill(KW_CAT);
    await page.waitForTimeout(40); // 远小于 200ms：此时不该生效
    const instantRows = await rows(page);
    await page.waitForTimeout(500);
    const settledRows = await rows(page);
    record(
      `${theme} 输入防抖 200ms`,
      instantRows === scoped.length && settledRows === KW_CAT_EXPECT.length,
      `输入后 40ms 仍 ${instantRows} 行（全量），停手后 ${settledRows} 行（期望 ${KW_CAT_EXPECT.length}）`,
    );

    /* ═══ 4. 分类名可搜 / 大小写不敏感 ═══ */
    await typeKeyword(page, KW_CAT);
    const catRows = await rows(page);
    record(
      `${theme} 按分类名「${KW_CAT}」可搜`,
      catRows === KW_CAT_EXPECT.length && catRows > 0 && catRows < scoped.length,
      `${catRows} 行，API 推导 ${KW_CAT_EXPECT.length} 行`,
    );
    await typeKeyword(page, KW_UPPER);
    const upperRows = await rows(page);
    record(
      `${theme} 关键字不区分大小写`,
      upperRows === KW_CASE_EXPECT.length,
      `「${KW_UPPER}」→ ${upperRows} 行，「${KW_CASE}」→ ${KW_CASE_EXPECT.length} 行`,
    );

    /* ═══ 5. 空白不过滤 ═══ */
    await typeKeyword(page, '   ');
    record(`${theme} 空白关键字不过滤`, (await rows(page)) === scoped.length, `仍为全量 ${await rows(page)} 行`);

    /* ═══ 6. 无命中空态，但搜索框必须保留 ═══ */
    await typeKeyword(page, KW_NONE);
    const noneRows = await rows(page);
    const stillHasBox = (await searchBox(page).count()) === 1;
    const boxValue = await searchBox(page).inputValue();
    const emptyText = await page.locator('text=暂无流水').count();
    record(
      `${theme} 无命中进空态`,
      noneRows === 0 && emptyText > 0,
      `${noneRows} 行，空态文案命中 ${emptyText} 处`,
    );
    record(
      `${theme} 空态下搜索框仍在可清空`,
      stillHasBox && boxValue === KW_NONE,
      `搜索框保留且仍显示「${boxValue}」`,
    );
    await page.screenshot({ path: `${SHOTS}/empty-${theme}.png` });

    /* ═══ 7. × 清空恢复全量 ═══ */
    await page.click('[data-testid="tx-search-clear"]');
    await page.waitForTimeout(450);
    record(
      `${theme} × 清空恢复全量`,
      (await searchBox(page).inputValue()) === '' &&
        (await rows(page)) === scoped.length &&
        (await countText(page)) === scoped.length,
      `恢复 ${await rows(page)} 行`,
    );

    /* ═══ 8. 不持久化 ═══ */
    await typeKeyword(page, KW);
    const beforeReload = await searchBox(page).inputValue();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="tx-search"]', { timeout: 25000 });
    await page.waitForTimeout(700);
    record(
      `${theme} 关键字不持久化`,
      beforeReload === KW && (await searchBox(page).inputValue()) === '',
      `刷新前「${beforeReload}」→ 刷新后「${await searchBox(page).inputValue()}」`,
    );

    /* ═══ 9. 与顶部筛选叠加（类型 = 支出） ═══ */
    await openTx(page);
    await typeKeyword(page, KW);
    const beforeType = await rows(page);
    const typeTrigger = page.locator('[role="combobox"]').first();
    await typeTrigger.click();
    await page.waitForTimeout(250);
    await page.locator('[role="option"]', { hasText: /^支出$/ }).first().click();
    await page.waitForTimeout(500);
    const afterType = await rows(page);
    const expectBoth = KW_EXPECT.filter((t) => t.type === 'expense').length;
    record(
      `${theme} 关键字与类型筛选取交集`,
      afterType === expectBoth && afterType <= beforeType,
      `叠加前 ${beforeType} 行 → 叠加「支出」后 ${afterType} 行（期望 ${expectBoth}）`,
    );
    // 复原筛选
    await typeTrigger.click();
    await page.waitForTimeout(250);
    await page.locator('[role="option"]', { hasText: /^全部$/ }).first().click();
    await page.waitForTimeout(500);
    record(`${theme} 筛选复原后关键字仍生效`, (await rows(page)) === KW_EXPECT.length, `${await rows(page)} 行`);

    /* ═══ 10. 与分组维度正交 ═══ */
    const perDim = {};
    for (const d of ['日', '周', '月', '年']) {
      await page.click(`[data-testid="tx-group-dim"] >> text=${d}`);
      await page.waitForTimeout(400);
      perDim[d] = await rows(page);
    }
    record(
      `${theme} 切分组维度命中数不变`,
      Object.values(perDim).every((n) => n === KW_EXPECT.length),
      Object.entries(perDim).map(([k, v]) => `${k}=${v}`).join(' · '),
    );
    await page.screenshot({ path: `${SHOTS}/final-${theme}.png` });

    await ctx.close();
  }

  /* ═══ 11. 移动端 390px ═══ */
  {
    const ctx = await newCtx(browser, 'light', { width: 390, height: 844 });
    const page = await ctx.newPage();
    watchErrors(page, 'mobile');
    await openTx(page);

    const fit = await page.evaluate(() => {
      const box = document.querySelector('[data-testid="tx-search"]');
      const parent = box?.closest('.card') ?? box?.parentElement;
      if (!box) return null;
      const b = box.getBoundingClientRect();
      const p = parent.getBoundingClientRect();
      return {
        overflowRight: b.right - p.right,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        width: b.width,
      };
    });
    record(
      '390px 搜索框不溢出',
      fit && fit.overflowRight <= 1,
      fit ? `溢出右 ${fit.overflowRight.toFixed(1)}px，宽 ${fit.width.toFixed(0)}px` : '未取到元素',
    );
    record('390px 页面无横向滚动', fit && fit.docOverflow <= 0, fit ? `溢出 ${fit.docOverflow}px` : '未取到元素');

    await typeKeyword(page, KW);
    const mRows = await rows(page);
    record('390px 搜索可用', mRows === KW_EXPECT.length, `「${KW}」→ ${mRows} 行（期望 ${KW_EXPECT.length}）`);
    await page.screenshot({ path: `${SHOTS}/mobile-390-light.png`, fullPage: false });
    await ctx.close();
  }

  /* ═══ 12. 无意外报错 ═══ */
  const isKnownKvMiss = (s) => /\/api\/kv\//.test(s);
  const unexpectedReqs = failedReqs.filter((r) => !isKnownKvMiss(r));
  const unexpectedConsole = consoleErrors.filter(
    (e) => !/Failed to load resource/.test(e) || unexpectedReqs.length > 0,
  );
  record(
    '无意外 console / page 报错',
    unexpectedConsole.length === 0 && unexpectedReqs.length === 0,
    [
      `kv 404（by-design）${failedReqs.length - unexpectedReqs.length} 次`,
      `意外 console ${unexpectedConsole.length} 条`,
      `意外失败请求 ${unexpectedReqs.length} 条`,
      unexpectedReqs.length ? unexpectedReqs.slice(0, 2).join(' | ') : '',
      // 失败时把原文打出来：只报"有 N 条"没法定位
      unexpectedConsole.length ? `→ ${[...new Set(unexpectedConsole)].slice(0, 3).join(' || ')}` : '',
    ]
      .filter(Boolean)
      .join(' · '),
  );
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
