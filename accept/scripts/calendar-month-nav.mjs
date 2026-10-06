/**
 * calendar-month-nav.mjs — 看板「收支日历」月份翻页验收
 * ---------------------------------------------------------------
 * 覆盖需求与验收点：
 *   1. 落地页默认显示**当前真实月**（‹ 2026年10月 › 形式），不读任何持久化残留
 *   2. 上界 = 当前真实月：当前月时「›」disabled
 *   3. 下界 = 最早交易所在月（从 /api/transactions 推导，不写死）：连翻到底「‹」disabled
 *   4. 翻到最早月（2025-12）日历有数据点，笔数与 API 推导一致（73 笔 / 27 个有数据日）
 *   5. **顶部概览不被日历月份带跑**：翻到历史月时「本月收入 / 本月支出」数值一字不变
 *   6. 切月清空当日弹层（selectedDay 归零）
 *   7. 「今天」按钮：仅离开当前月时出现，点击回到当前月
 *   8. 选择不持久化：刷新后回到当前月
 *   9. 移动端 390px：翻页器不挤爆卡片（不溢出、不换行破版）
 *  10. 明暗双主题各跑一轮；全程无 console error / pageerror
 *  11. 月份选择弹层：点月份文字打开、年份 ‹ › 翻到下界、3×4 网格、
 *      未来月/早于下界的月置灰禁用、当前月高亮、选月即时生效并自关、
 *      Esc / 点遮罩关闭且不改动月份
 * （第 1~10 项为历史回归，第 11 项随月份选择控件一并加入；改动不得让前 39 条断言回归）
 *
 * 数据策略：core 全程只读。所有期望值（下界月份、笔数、数据日数、概览金额）
 * 都从 http://127.0.0.1:8787/api/transactions 现算，脚本里不写死任何业务数字。
 *
 * 已知且与本次改动无关的例外：core 的 GET /api/kv/nickname 对"未设置"的昵称返回 404
 * （用任意不存在的 key 直连 8787 同样 404，属服务端 by-design 行为，见
 * Dashboard.tsx 注释与 dexie-purge-smoke.mjs）。该 404 单独统计，不计入失败。
 *
 * 用法：node accept/scripts/calendar-month-nav.mjs
 *       BASE_URL=http://127.0.0.1:5185 node accept/scripts/calendar-month-nav.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5185';
const API = process.env.CORE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = 'accept/screenshots/calendar-nav';
mkdirSync(SHOTS, { recursive: true });

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail}`);
}

/* ─────────────── 错误采集 ─────────────── */

/** 已知例外：core 对未设置的 kv key 回 404（服务端 by-design） */
const isKnownKvMiss = (s) => /\/api\/kv\//.test(s);

const consoleErrors = [];
const failedReqs = [];
function watchErrors(page, bucket, tag) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(`[${tag}] ${m.text().slice(0, 160)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 160)}`));
  page.on('response', (r) => {
    if (r.status() >= 400) failedReqs.push(`[${tag}] HTTP ${r.status()} ${r.url()}`);
  });
  void bucket;
}

/* ─────────────── 从 API 推导期望值（不写死业务数字） ─────────────── */

const CALENDAR_TYPES = new Set(['income', 'expense']); // 与 buildCalendar 口径一致

function localMonthKey(ms) {
  // 用本地时区（dayjs 默认行为）取月份，勿用 UTC
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthLabelOf = (key) => `${key.slice(0, 4)}年${Number(key.slice(5, 7))}月`;

const txRows = await fetch(`${API}/api/transactions`).then((r) => r.json());
const visible = txRows.filter((t) => CALENDAR_TYPES.has(t.type));
const EXPECT = {
  totalTx: txRows.length,
  currentMonth: localMonthKey(Date.now()),
  earliestMonth: visible.reduce((min, t) => (min === null || t.date < min ? t.date : min), null),
};
EXPECT.earliestMonthKey = EXPECT.earliestMonth === null ? EXPECT.currentMonth : localMonthKey(EXPECT.earliestMonth);
EXPECT.months = {};
for (const t of visible) {
  const d = new Date(t.date);
  const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const dayKey = `${k}-${String(d.getDate()).padStart(2, '0')}`;
  const e = (EXPECT.months[k] ??= { tx: 0, days: new Set() });
  e.tx += 1;
  e.days.add(dayKey);
}
const earliestStats = EXPECT.months[EXPECT.earliestMonthKey];
/* 顶部概览的期望值：锚在"真实当前月"上，与日历所选月无关 */
const sumOf = (monthKey, type) => {
  let sum = 0;
  for (const t of visible) {
    if (t.type !== type || t.includeInAsset === false) continue;
    if (localMonthKey(t.date) === monthKey) sum += t.amount;
  }
  return sum;
};
EXPECT.currentIncome = sumOf(EXPECT.currentMonth, 'income');
EXPECT.currentExpense = sumOf(EXPECT.currentMonth, 'expense');
/* 找一个"日历翻过去就会变"的历史月，让不变性断言不是 0 === 0 的空断言 */
EXPECT.probeMonthKey = Object.keys(EXPECT.months)
  .filter((k) => k < EXPECT.currentMonth)
  .sort()
  .at(-1);
EXPECT.probeIncome = sumOf(EXPECT.probeMonthKey, 'income');
EXPECT.probeExpense = sumOf(EXPECT.probeMonthKey, 'expense');
console.log(
  `期望值（API 推导）：共 ${EXPECT.totalTx} 笔 · 当前月 ${EXPECT.currentMonth} · 最早月 ${EXPECT.earliestMonthKey}` +
    ` · 该月 ${earliestStats.tx} 笔 / ${earliestStats.days.size} 个有数据日\n` +
    `概览期望（锚当前月 ${EXPECT.currentMonth}）：收入 ¥${EXPECT.currentIncome.toFixed(2)} · 支出 ¥${EXPECT.currentExpense.toFixed(2)}` +
    `（对照历史月 ${EXPECT.probeMonthKey}：收入 ¥${EXPECT.probeIncome.toFixed(2)} · 支出 ¥${EXPECT.probeExpense.toFixed(2)}）\n`,
);

/* ─────────────── 页面辅助 ─────────────── */

/** 当日流水弹层：通用 Modal 不带 role="dialog"，按标题「… 流水」定位（天气城市弹层标题不同，不冲突） */
const dayModal = (page) => page.locator('div.fixed.inset-0.z-50').filter({ hasText: '流水' });

async function newCtx(browser, theme, viewport = { width: 1440, height: 1000 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript(
    ([t]) => {
      localStorage.setItem('hifin:theme', JSON.stringify(t));
      localStorage.setItem('hifin:spaceId', '1');
      // 日历月份按需求不持久化：这里主动埋一个"脏"残留，若实现误读它应当被无视
      localStorage.setItem('hifin:dashCalendarMonth', JSON.stringify('2019-01'));
    },
    [theme],
  );
  return ctx;
}

async function openDash(page) {
  await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="dash-calendar"]', { timeout: 20000 });
  await page.waitForTimeout(700);
}

const monthLabel = (page) => page.locator('[data-testid="dash-calendar-label"]').innerText().then((t) => t.trim());
/** 顶部「本月收入/支出」卡片的金额解析成数字（卡片还含标签与环比文案，只取主金额） */
const overview = (page) =>
  page.evaluate(() => {
    const grab = (id) => {
      const el = document.querySelector(`[data-testid="${id}"]`);
      const m = (el?.innerText ?? '').match(/¥\s*([\d,]+\.\d{2})/);
      return m ? parseFloat(m[1].replace(/,/g, '')) : NaN;
    };
    return { income: grab('stat-month-income'), expense: grab('stat-month-expense') };
  });
const near = (a, b) => Math.abs(a - b) < 0.005;
/** 日历网格里有数据点（右上角圆点）的日期格数 */
const dataCells = (page) =>
  page.locator('[data-testid="dash-calendar"] .grid.grid-cols-7 > button:has(span.rounded-full)').count();
/** 某月的目标标签 -> 逐月回翻一次一步 */
async function stepUntil(page, prev, targetKey, limit = 60) {
  for (let i = 0; i < limit; i++) {
    if ((await monthLabel(page)) === monthLabelOf(targetKey)) return true;
    if (await prev.isDisabled()) return false; // 到底了还没到 → 失败
    await prev.click();
    await page.waitForTimeout(160);
  }
  return false;
}

const browser = await chromium.launch();

try {
  for (const theme of ['light', 'dark']) {
    console.log(`──── ${theme === 'light' ? '明亮' : '暗黑'}主题 ────`);
    const ctx = await newCtx(browser, theme);
    const page = await ctx.newPage();
    watchErrors(page, consoleErrors, theme);

    /* ═══ 1. 落地默认当前月 + 上界 disabled ═══ */
    await openDash(page);
    const label0 = await monthLabel(page);
    record(
      `${theme} 落地默认当前月`,
      label0 === monthLabelOf(EXPECT.currentMonth),
      `「${label0}」（期望 ${monthLabelOf(EXPECT.currentMonth)}）`,
    );
    record(
      `${theme} 当前月 › disabled`,
      await page.locator('[data-testid="dash-calendar-next"]').isDisabled(),
      '上界=真实当前月',
    );
    record(
      `${theme} 当前月无「今天」按钮`,
      (await page.locator('[data-testid="dash-calendar-today"]').count()) === 0,
      '仅离开当前月时出现',
    );
    const ov0 = await overview(page);
    record(
      `${theme} 概览锚在真实当前月`,
      near(ov0.income, EXPECT.currentIncome) && near(ov0.expense, EXPECT.currentExpense),
      `收入 ¥${ov0.income} / 支出 ¥${ov0.expense}（期望 ¥${EXPECT.currentIncome.toFixed(2)} / ¥${EXPECT.currentExpense.toFixed(2)}）`,
    );

    /* ═══ 2. 翻一页 → 概览不动 + 弹层清空 ═══ */
    // 点开一个"有流水"的日期格，验证切月会关掉当日弹层
    const dayWithTx = page.locator('[data-testid="dash-calendar"] .grid.grid-cols-7 > button:has(span.rounded-full)').first();
    await dayWithTx.click();
    await page.waitForSelector('div.fixed.inset-0.z-50:has-text("流水")', { timeout: 10000 });
    await page.waitForTimeout(400);
    const modalOpen = await dayModal(page).count();
    await page.screenshot({ path: `${SHOTS}/day-modal-${theme}.png` });

    // 弹层遮罩盖住整屏，鼠标点不到翻页器；此处直接派发 click 事件，
    // 验的是"切月必须清空 selectedDay"这条组件状态不变量（而不是指针可达性）
    await page.locator('[data-testid="dash-calendar-prev"]').evaluate((el) => el.click());
    await page.waitForTimeout(450);
    const label1 = await monthLabel(page);
    const ov1 = await overview(page);
    record(`${theme} ‹ 翻到上一月`, label1 !== label0, `「${label0}」→「${label1}」`);
    record(
      `${theme} 翻历史月概览不变`,
      near(ov1.income, ov0.income) && near(ov1.expense, ov0.expense),
      `收入 ¥${ov1.income} / 支出 ¥${ov1.expense}，与当前月口径一致`,
    );
    record(
      `${theme} 概览未跟到历史月`,
      EXPECT.probeMonthKey === undefined ||
        (!near(ov1.income, EXPECT.probeIncome) && !near(ov1.expense, EXPECT.probeExpense)),
      `对照 ${EXPECT.probeMonthKey} 收入 ¥${EXPECT.probeIncome.toFixed(2)} / 支出 ¥${EXPECT.probeExpense.toFixed(2)}，看板未采用`,
    );
    const modalAfter = await dayModal(page).count();
    record(
      `${theme} 切月清空当日弹层`,
      modalOpen === 1 && modalAfter === 0,
      `点开当日=${modalOpen} 个「流水」弹层 → 翻月后=${modalAfter}`,
    );
    record(
      `${theme} 离开当前月出现「今天」`,
      (await page.locator('[data-testid="dash-calendar-today"]').count()) === 1,
      `「${label1}」`,
    );
    await page.screenshot({ path: `${SHOTS}/prev-month-${theme}.png` });

    /* ═══ 3. 一路翻到最早月 ═══ */
    const prev = page.locator('[data-testid="dash-calendar-prev"]');
    const reached = await stepUntil(page, prev, EXPECT.earliestMonthKey);
    const labelMin = await monthLabel(page);
    record(
      `${theme} 可回翻到最早交易月`,
      reached && labelMin === monthLabelOf(EXPECT.earliestMonthKey),
      `「${labelMin}」（${earliestStats.tx} 笔 / ${earliestStats.days.size} 个有数据日）`,
    );
    record(
      `${theme} 最早月 ‹ disabled`,
      await prev.isDisabled(),
      `下界=${EXPECT.earliestMonthKey}，到达后不可再退`,
    );
    const cells = await dataCells(page);
    record(
      `${theme} 最早月日历有数据点`,
      cells === earliestStats.days.size,
      `网格 ${cells} 个有数据日，API 推导 ${earliestStats.days.size} 个（该月 ${earliestStats.tx} 笔）`,
    );
    const ovMin = await overview(page);
    record(
      `${theme} 最早月概览仍为当月口径`,
      near(ovMin.income, EXPECT.currentIncome) && near(ovMin.expense, EXPECT.currentExpense),
      `收入 ¥${ovMin.income} / 支出 ¥${ovMin.expense}，未变成 ${EXPECT.earliestMonthKey} 的口径`,
    );
    await page.screenshot({ path: `${SHOTS}/earliest-month-${theme}.png` });

    /* ═══ 4. 「今天」回当前月 ═══ */
    await page.click('[data-testid="dash-calendar-today"]');
    await page.waitForTimeout(400);
    const labelBack = await monthLabel(page);
    record(
      `${theme} 「今天」回到当前月`,
      labelBack === monthLabelOf(EXPECT.currentMonth),
      `「${labelMin}」→「${labelBack}」`,
    );
    record(
      `${theme} 回到当前月后 › 再次 disabled`,
      await page.locator('[data-testid="dash-calendar-next"]').isDisabled(),
      '上界重新生效',
    );
    record(
      `${theme} 回到当前月后「今天」消失`,
      (await page.locator('[data-testid="dash-calendar-today"]').count()) === 0,
      '按钮按需出现',
    );

    /* ═══ 5. 不持久化 ═══ */
    await page.click('[data-testid="dash-calendar-prev"]');
    await page.waitForTimeout(300);
    const beforeReload = await monthLabel(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="dash-calendar"]', { timeout: 20000 });
    await page.waitForTimeout(600);
    const afterReload = await monthLabel(page);
    record(
      `${theme} 翻月不持久化`,
      beforeReload !== afterReload && afterReload === monthLabelOf(EXPECT.currentMonth),
      `翻到「${beforeReload}」→ 刷新后「${afterReload}」`,
    );

    /* ═══ 6. 月份选择弹层（点月份文字打开） ═══ */
    await openDash(page);
    const curYear = Number(EXPECT.currentMonth.slice(0, 4));
    const curMonthNo = Number(EXPECT.currentMonth.slice(5, 7));
    const minYear = Number(EXPECT.earliestMonthKey.slice(0, 4));
    const minMonthNo = Number(EXPECT.earliestMonthKey.slice(5, 7));
    const picker = page.locator('[data-testid="month-picker"]');
    const cell = (m) => page.locator(`[data-testid="month-picker-cell"][data-month="${m}"]`);
    const yearOf = () => page.locator('[data-testid="month-picker-year"]').innerText().then((t) => t.trim());

    await page.click('[data-testid="dash-calendar-label"]');
    await page.waitForSelector('[data-testid="month-picker"]', { timeout: 8000 });
    await page.waitForTimeout(300);
    record(
      `${theme} 点月份文字打开选择弹层`,
      (await picker.count()) === 1,
      `默认停在「${await yearOf()}」`,
    );
    await page.screenshot({ path: `${SHOTS}/month-picker-open-${theme}.png` });

    // 网格必须是 3 行 × 4 列 = 12 格
    const shape = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-testid="month-picker-grid"] > div')];
      return { rows: rows.length, perRow: rows.map((r) => r.querySelectorAll('button').length) };
    });
    record(
      `${theme} 弹层为 3×4 月份网格`,
      shape.rows === 3 && shape.perRow.length === 3 && shape.perRow.every((n) => n === 4),
      `${shape.rows} 行 × 每行 ${shape.perRow.join('/')} 格`,
    );
    record(`${theme} 弹层默认年份=当前年`, (await yearOf()) === `${curYear}年`, `当前 ${curYear}年${curMonthNo}月`);

    // 禁用态：未来月置灰；当前月带 data-current 且可点
    const dis = await page.evaluate(
      ([cm]) => {
        const g = (m) => document.querySelector(`[data-testid="month-picker-cell"][data-month="${m}"]`);
        return {
          future: [cm + 1, 12].filter((m) => m <= 12).every((m) => g(m)?.disabled === true),
          pastOk: cm > 1 ? g(cm - 1)?.disabled === false : true,
          curEnabled: g(cm)?.disabled === false,
          curMarked: g(cm)?.getAttribute('data-current') === 'true',
          curSelected: g(cm)?.getAttribute('data-selected') === 'true',
        };
      },
      [curMonthNo],
    );
    record(
      `${theme} 未来月置灰禁用`,
      dis.future && dis.pastOk && dis.curEnabled,
      `当前月 ${curMonthNo} 可选，${curMonthNo + 1}~12 月 disabled`,
    );
    record(
      `${theme} 当前月高亮且为选中态`,
      dis.curMarked && dis.curSelected,
      `data-current=${dis.curMarked} data-selected=${dis.curSelected}`,
    );

    // 年份翻页到下界年：早于最早交易月的月份必须禁用
    const prevYear = page.locator('[data-testid="month-picker-prev-year"]');
    for (let i = 0; i < 30 && !(await prevYear.isDisabled()); i++) {
      await prevYear.click();
      await page.waitForTimeout(120);
    }
    const shownYear = Number((await yearOf()).slice(0, 4));
    const minDis = await page.evaluate(
      ([shown, boundYear, boundMonth]) => {
        const g = (m) => document.querySelector(`[data-testid="month-picker-cell"][data-month="${m}"]`);
        // 早于下界（按 年-月 字典序）的月份集合
        const below = [...Array(12).keys()]
          .map((i) => i + 1)
          .filter((m) => shown < boundYear || (shown === boundYear && m < boundMonth));
        return {
          belowCount: below.length,
          belowDisabled: below.every((m) => g(m)?.disabled === true),
          boundEnabled: shown > boundYear ? below.length === 0 : g(boundMonth)?.disabled === false,
        };
      },
      [shownYear, minYear, minMonthNo],
    );
    record(
      `${theme} 下界年早于最早交易月的月禁用`,
      shownYear === minYear && minDis.belowDisabled && minDis.boundEnabled,
      `翻到 ${shownYear}年（最早交易 ${EXPECT.earliestMonthKey}）：${minDis.belowCount} 个更早的月全部 disabled，${minMonthNo} 月可选`,
    );
    await page.screenshot({ path: `${SHOTS}/month-picker-minyear-${theme}.png` });

    // 选月：落 calendarMonth + 关闭弹层
    const targetMonth = shownYear === minYear ? minMonthNo : curMonthNo;
    await cell(targetMonth).click();
    await page.waitForTimeout(400);
    const labelAfterPick = await monthLabel(page);
    record(
      `${theme} 选月即时生效并关闭弹层`,
      labelAfterPick === monthLabelOf(EXPECT.earliestMonthKey) && (await picker.count()) === 0,
      `选 ${shownYear}年${targetMonth}月 → 标签「${labelAfterPick}」，弹层已关`,
    );
    await page.screenshot({ path: `${SHOTS}/month-picker-picked-${theme}.png` });

    // Esc 关闭
    await page.click('[data-testid="dash-calendar-label"]');
    await page.waitForSelector('[data-testid="month-picker"]', { timeout: 8000 });
    await page.waitForTimeout(250);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    const labelAfterEsc = await monthLabel(page);
    record(
      `${theme} Esc 关闭月份弹层`,
      (await picker.count()) === 0 && labelAfterEsc === labelAfterPick,
      `月份保持「${labelAfterEsc}」未被改动`,
    );

    // 点遮罩关闭
    await page.click('[data-testid="dash-calendar-label"]');
    await page.waitForSelector('[data-testid="month-picker"]', { timeout: 8000 });
    await page.waitForTimeout(250);
    await page.mouse.click(10, 10); // 遮罩左上角：避开中间的弹层卡片
    await page.waitForTimeout(350);
    record(
      `${theme} 点遮罩关闭月份弹层`,
      (await picker.count()) === 0 && (await monthLabel(page)) === labelAfterPick,
      `月份保持「${labelAfterPick}」未被改动`,
    );
    await page.screenshot({ path: `${SHOTS}/month-picker-after-${theme}.png` });

    await ctx.close();
  }

  /* ═══ 6. 移动端 390px 不挤爆 ═══ */
  {
    const ctx = await newCtx(browser, 'light', { width: 390, height: 844 });
    const page = await ctx.newPage();
    watchErrors(page, consoleErrors, 'mobile');
    await openDash(page);
    await page.click('[data-testid="dash-calendar-prev"]'); // 让「今天」出现，测最宽形态
    await page.waitForTimeout(400);

    const fit = await page.evaluate(() => {
      const nav = document.querySelector('[data-testid="dash-calendar-nav"]');
      const card = nav?.closest('.card');
      if (!nav || !card) return null;
      const n = nav.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const label = document.querySelector('[data-testid="dash-calendar-label"]');
      return {
        navW: n.width,
        navRight: n.right,
        cardRight: c.right,
        cardLeft: c.left,
        overflowRight: n.right - c.right,
        overflowLeft: c.left - n.left,
        docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        labelText: label?.textContent?.trim() ?? '',
        labelH: label?.getBoundingClientRect().height ?? 0,
      };
    });
    record(
      '390px 翻页器不溢出卡片',
      fit && fit.overflowRight <= 1 && fit.overflowLeft <= 1,
      fit
        ? `溢出右 ${fit.overflowRight.toFixed(1)}px / 左 ${fit.overflowLeft.toFixed(1)}px，导航宽 ${fit.navW.toFixed(0)}px`
        : '未取到元素',
    );
    record(
      '390px 页面无横向滚动',
      fit && fit.docOverflow <= 0,
      fit ? `scrollWidth 溢出 ${fit.docOverflow}px` : '未取到元素',
    );
    record(
      '390px 月份标签单行显示',
      fit && fit.labelH < 24,
      fit ? `「${fit.labelText}」行高 ${fit.labelH.toFixed(0)}px` : '未取到元素',
    );
    const cardBox = await page.locator('[data-testid="dash-calendar"]').boundingBox();
    record('390px 日历卡片可见', !!cardBox && cardBox.width > 300, cardBox ? `宽 ${cardBox.width.toFixed(0)}px` : '');
    await page.screenshot({ path: `${SHOTS}/mobile-390-light.png`, fullPage: true });

    /* 390px 下的月份选择弹层：不溢出、可选可禁 */
    await page.click('[data-testid="dash-calendar-label"]');
    await page.waitForSelector('[data-testid="month-picker"]', { timeout: 8000 });
    await page.waitForTimeout(400);
    const pickerFit = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="month-picker"]');
      const card = root?.closest('.fixed.inset-0.z-50 > div.relative');
      const doc = document.documentElement;
      const cells = [...document.querySelectorAll('[data-testid="month-picker-cell"]')];
      return {
        overflowRight: card ? root.getBoundingClientRect().right - card.getBoundingClientRect().right : NaN,
        docOverflow: doc.scrollWidth - doc.clientWidth,
        cells: cells.length,
        cellW: cells[0]?.getBoundingClientRect().width ?? 0,
        selected: cells.filter((c) => c.getAttribute('data-selected') === 'true').length,
        disabled: cells.filter((c) => c.disabled).length,
      };
    });
    record(
      '390px 月份弹层不溢出',
      Number.isFinite(pickerFit.overflowRight) &&
        pickerFit.overflowRight <= 1 &&
        pickerFit.docOverflow <= 0,
      `溢出右 ${pickerFit.overflowRight.toFixed(1)}px / 页面横向 ${pickerFit.docOverflow}px`,
    );
    record(
      '390px 弹层格子不挤爆',
      pickerFit.cells === 12 && pickerFit.cellW > 60 && pickerFit.selected === 1,
      `${pickerFit.cells} 格，每格宽 ${pickerFit.cellW.toFixed(0)}px，选中 ${pickerFit.selected} 个，禁用 ${pickerFit.disabled} 个`,
    );
    await page.screenshot({ path: `${SHOTS}/mobile-390-picker.png` });
    await ctx.close();
  }

  const unexpectedReqs = failedReqs.filter((r) => !isKnownKvMiss(r));
  const kvMisses = failedReqs.length - unexpectedReqs.length;
  // console 里的 404 只表现为通用 "Failed to load resource" 文本，靠 failedReqs 的 kv 数量对齐
  const unexpectedConsole = consoleErrors.filter(
    (e) => !/Failed to load resource/.test(e) || unexpectedReqs.length > 0,
  );
  record(
    '无意外 console / page 报错',
    unexpectedConsole.length === 0 && unexpectedReqs.length === 0,
    [
      `kv/nickname 404（by-design）${kvMisses} 次`,
      `意外 console ${unexpectedConsole.length} 条`,
      `意外失败请求 ${unexpectedReqs.length} 条`,
      unexpectedReqs.length ? unexpectedReqs.slice(0, 2).join(' | ') : '',
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
