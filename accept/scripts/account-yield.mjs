/**
 * account-yield.mjs — 账户「年收益率」验收
 * ---------------------------------------------------------------
 * 覆盖需求与验收点：
 *   1. 列表：有收益率 + 正余额 → 同行展示「年收益率 2.1% · 预计年收益 ¥ 210.00」
 *   2. 列表：负余额 → 只给百分比，不给"预计"（负收益没有参考价值）
 *   3. 列表：负债账户（花呗）→ 恒不展示该字段
 *   4. 列表：core 未下发 latestYield 时容错，不渲染空行/NaN
 *   5. 表单：「年收益率（%）」字段渲染在余额之后
 *   6. 表单：留空可提交 —— 且**不调用** yield 接口（而不是 PUT 0）
 *   7. 表单：填 2.1 提交 → PUT /api/accounts/:id/yields/<当前年> body { yieldPercent: 2.1 }
 *   8. 表单：范围校验 101 被拦下、给出中文原因、且不发任何写请求
 *   9. 明暗双主题各跑一轮，全程无 console error / pageerror
 *
 * 数据与接口策略
 * ------------------------------------------------------------------
 * core 的 accountYields 接口（PUT/GET /api/accounts/:id/yields/:year）**尚未上线**
 * （当前 :8787 返回 404，GET /api/accounts 也不带 latestYield），因此本脚本
 * 用 page.route 拦截：
 *   - GET  /api/accounts            → 喂固定夹具（含 latestYield），让列表展示可断言
 *   - POST /api/accounts            → 返回 { id: 9001 }，让"新建后拿 id 再 PUT"能跑通
 *   - PUT  /api/accounts/:id/yields/:year → 200，并记录请求体供断言
 * 其余接口一律 route.fallback() 放行到真实 :8787。
 *
 * 写操作全部被 mock，**不会往用户的真实 dev 库里塞测试账户**。
 *
 * 用法：node accept/scripts/account-yield.mjs
 *       BASE_URL=http://127.0.0.1:5185 node accept/scripts/account-yield.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5185';
const SHOTS = 'accept/screenshots/account-yield';
mkdirSync(SHOTS, { recursive: true });

/** 与被测页面保持同一时区的"当前年"，用于断言 PUT 的路径 */
const THIS_YEAR = new Date().getFullYear();

/* ─────────────── 固定夹具（列表展示用，不依赖真实 dev 数据） ─────────────── */

/** 与 REST 原始行同形：includeInNetAsset 是 0/1、remark 可为 null */
const FIXTURE_ACCOUNTS = [
  {
    id: 9001,
    name: '验收-有收益率',
    type: 'fund',
    balance: 10000,
    remark: null,
    tagIds: null,
    includeInNetAsset: 1,
    spaceId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    latestYield: { year: THIS_YEAR, yieldPercent: 2.1 },
  },
  {
    // 负余额：只显示百分比
    id: 9002,
    name: '验收-负余额',
    type: 'fund',
    balance: -36089.78,
    remark: null,
    tagIds: null,
    includeInNetAsset: 1,
    spaceId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    latestYield: { year: THIS_YEAR, yieldPercent: 2.1 },
  },
  {
    // 负债账户：即使有 latestYield 也不得展示
    id: 9003,
    name: '花呗',
    type: 'credit',
    balance: 139.29,
    remark: null,
    tagIds: null,
    includeInNetAsset: 1,
    spaceId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    latestYield: { year: THIS_YEAR, yieldPercent: 18 },
  },
  {
    // core 未下发 latestYield：容错为 null，不渲染收益率行
    id: 9004,
    name: '验收-无收益率',
    type: 'fund',
    balance: 5000,
    remark: null,
    tagIds: null,
    includeInNetAsset: 1,
    spaceId: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
];
const NEW_ACCOUNT_ID = 9001; // POST 返回的 id
const EXPECT_POSITIVE = `年收益率 2.1% · 预计年收益 ${money(10000 * 0.021)}`;

/** 与 app 侧 formatMoney 同口径（¥ + 千分位 + 2 位小数） */
function money(v) {
  const [int, dec] = Math.abs(v).toFixed(2).split('.');
  const sign = v < 0 ? '-' : '';
  return `¥ ${sign}${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${dec}`;
}

/* ─────────────── 结果收集 ─────────────── */

const results = [];
function record(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(38)} ${detail}`);
}

const consoleErrors = [];
/**
 * 第 9 步会**故意**让 yield 接口返回 500，浏览器必然打一条
 * "Failed to load resource: 500" 的 console error —— 那是被测行为本身，不是缺陷。
 * 用这个开关把这段时间内的 500 噪音排除，其他错误照常计。
 */
let expectingHttp500 = false;
function watchErrors(page, tag) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text().slice(0, 160);
    if (expectingHttp500 && /status of 500/.test(text)) return;
    consoleErrors.push(`[${tag}] ${text}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`[${tag}] pageerror: ${String(e).slice(0, 160)}`));
}

/* ─────────────── 请求打桩 ─────────────── */

/**
 * 单一 catch-all 路由 + fallback：只接管账户相关接口，其余放行真实 core。
 * 用一个 handler 而不是注册多个 glob，是为了避免路由匹配顺序陷阱
 * （Playwright 中后注册的 route 优先，`**\/api\/accounts` 会连带吃掉
 * `/api/accounts/9001/yields/2026`）。
 */
async function stubApi(page, sink) {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const body = safeJson(req.postData());

    // PUT /api/accounts/:id/yields/:year —— 年收益率 upsert
    const yieldPut = path.match(/^\/api\/accounts\/(\d+)\/yields\/(\d{4})$/);
    if (method === 'PUT' && yieldPut) {
      sink.yieldCalls.push({ id: Number(yieldPut[1]), year: Number(yieldPut[2]), body });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
      return;
    }

    // GET /api/accounts/:id/yields
    if (method === 'GET' && /^\/api\/accounts\/\d+\/yields$/.test(path)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ year: THIS_YEAR, yieldPercent: 2.1, note: null }]),
      });
      return;
    }

    // POST /api/accounts —— 新建，返回带 id 的行（前端据此再 PUT 收益率）
    if (method === 'POST' && path === '/api/accounts') {
      sink.accountWrites.push({ method, path, body });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ ...FIXTURE_ACCOUNTS[0], id: NEW_ACCOUNT_ID, ...body }),
      });
      return;
    }

    // PUT /api/accounts/:id —— 编辑
    if (method === 'PUT' && /^\/api\/accounts\/\d+$/.test(path)) {
      sink.accountWrites.push({ method, path, body });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: Number(path.split('/')[3]), ...body }),
      });
      return;
    }

    // GET /api/accounts —— 列表夹具
    if (method === 'GET' && path === '/api/accounts') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(FIXTURE_ACCOUNTS),
      });
      return;
    }

    await route.fallback();
  });
}

function safeJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/* ─────────────── 页面辅助 ─────────────── */

async function newCtx(browser, theme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.addInitScript(
    ([t, s]) => {
      localStorage.setItem('hifin:theme', JSON.stringify(t));
      localStorage.setItem('hifin:spaceId', String(s));
    },
    [theme, 1],
  );
  return ctx;
}

async function openList(page) {
  await page.goto(`${BASE}/account/list`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="account-card"]', { timeout: 25000 });
  await page.waitForTimeout(400);
}

/** 名称 → 该卡片内的收益率行文本（没有则 null） */
function yieldLineOf(page, accountName) {
  return page.evaluate((name) => {
    for (const card of document.querySelectorAll('[data-testid="account-card"]')) {
      const nameEl = card.querySelector('.min-w-0 > .text-sm');
      if (nameEl?.textContent?.trim() === name) {
        return card.querySelector('[data-testid="account-yield"]')?.textContent?.trim() ?? null;
      }
    }
    return null;
  }, accountName);
}

/** 打开「新建账户」模态并走到第二步（类型已选） */
async function openCreateForm(page) {
  await page.getByRole('button', { name: '新建账户' }).first().click();
  await page.waitForSelector('text=选择账户类型', { timeout: 10000 });
  // 选「资金」账户（fund，资产类），再下一步
  await page.getByRole('button', { name: /^资金/ }).first().click();
  await page.getByRole('button', { name: '下一步' }).click();
  await page.waitForSelector('[data-testid="yield-percent-input"]', { timeout: 10000 });
}

const yieldInput = (page) => page.locator('[data-testid="yield-percent-input"]');
const fillName = (page) => page.getByPlaceholder('请输入资金账户名称');
const confirmBtn = (page) => page.getByRole('button', { name: /^确认$|保存中/ });

/* ─────────────── 主流程 ─────────────── */

const browser = await chromium.launch();

try {
  for (const theme of ['light', 'dark']) {
    console.log(`──── ${theme === 'light' ? '明亮' : '暗黑'}主题 ────`);
    const ctx = await newCtx(browser, theme);
    const page = await ctx.newPage();
    watchErrors(page, theme);

    // 每轮独立的请求记录
    const sink = { yieldCalls: [], accountWrites: [] };
    await stubApi(page, sink);

    /* ═══ 1. 正余额账户：百分比 + 预计年收益 同行 ═══ */
    await openList(page);
    const positiveLine = await yieldLineOf(page, '验收-有收益率');
    record(
      `${theme} 正余额展示「收益率 · 预计年收益」`,
      positiveLine === EXPECT_POSITIVE,
      `实际「${positiveLine}」`,
    );

    /* ═══ 2. 负余额：只给百分比 ═══ */
    const negativeLine = await yieldLineOf(page, '验收-负余额');
    record(
      `${theme} 负余额只显示百分比`,
      negativeLine === '年收益率 2.1%',
      `实际「${negativeLine}」`,
    );

    /* ═══ 3. 负债账户不展示 ═══ */
    const debtLine = await yieldLineOf(page, '花呗');
    record(`${theme} 花呗不展示年收益率`, debtLine === null, `实际「${debtLine}」`);

    /* ═══ 4. latestYield 缺失容错 ═══ */
    const noneLine = await yieldLineOf(page, '验收-无收益率');
    record(`${theme} 无 latestYield 时不渲染空行`, noneLine === null, `实际「${noneLine}」`);

    await page.screenshot({ path: `${SHOTS}/list-${theme}.png`, fullPage: false });

    /* ═══ 5. 表单字段渲染，且排在「账户余额」之后 ═══ */
    await openCreateForm(page);
    const fieldVisible = await yieldInput(page).isVisible();
    // label 与 hint 是兄弟节点，整体文案要从 Field 外层容器取
    const fieldText = await page.evaluate(() => {
      for (const l of document.querySelectorAll('label')) {
        if ((l.textContent ?? '').includes('年收益率')) {
          return l.parentElement?.parentElement?.textContent?.trim() ?? '';
        }
      }
      return '';
    });
    const orderOk = await page.evaluate(() => {
      const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim() ?? '');
      return labels.indexOf('账户余额') < labels.findIndex((l) => l.startsWith('年收益率'));
    });
    record(
      `${theme} 表单渲染「年收益率（%）」字段`,
      fieldVisible &&
        fieldText.includes('年收益率（%）') &&
        fieldText.includes('选填') &&
        fieldText.includes('-100~100'),
      `字段块文案「${fieldText}」，可见=${fieldVisible}`,
    );
    record(`${theme} 字段排在余额之后`, orderOk, `账户余额 → 年收益率`);

    await page.screenshot({ path: `${SHOTS}/form-${theme}.png`, fullPage: false });

    /* ═══ 6. 范围校验：101 拦下、给出中文原因、且不发任何写请求 ═══ */
    await fillName(page).fill('验收-范围校验');
    await yieldInput(page).fill('101');
    await page.waitForSelector('[data-testid="yield-error"]', { timeout: 5000 });
    const rangeError = await page.locator('[data-testid="yield-error"]').innerText();
    // 越界时「确认」必须是被拦住的（disabled），否则等于没校验
    const disabledAtInvalid = await confirmBtn(page).isDisabled();
    record(
      `${theme} 超出 100% 拦下 + 提示原因`,
      rangeError.includes('不能大于 100') && disabledAtInvalid && sink.accountWrites.length === 0,
      `提示「${rangeError}」，确认按钮 disabled=${disabledAtInvalid}，写请求 ${sink.accountWrites.length} 条`,
    );

    /* ═══ 6b. 负收益合法（投资亏损），-100 以下才拦下 ═══ */
    await yieldInput(page).fill('-1');
    await page.waitForTimeout(150);
    const negErrCount = await page.locator('[data-testid="yield-error"]').count();
    record(
      `${theme} 负收益合法不拦截`,
      negErrCount === 0 && (await confirmBtn(page).isEnabled()),
      `错误提示数=${negErrCount}，确认按钮可点`,
    );
    await yieldInput(page).fill('-100.1');
    await page.waitForSelector('[data-testid="yield-error"]', { timeout: 5000 });
    const negError = await page.locator('[data-testid="yield-error"]').innerText();
    record(
      `${theme} 低于 -100% 拦下`,
      negError.includes('不能小于 -100') && sink.accountWrites.length === 0,
      `提示「${negError}」，写请求 ${sink.accountWrites.length} 条`,
    );

    /* ═══ 6c. 越界值改成合法值后红框消失，按钮恢复可点 ═══ */
    await yieldInput(page).fill('2.1');
    await page.waitForTimeout(150);
    const errGone = (await page.locator('[data-testid="yield-error"]').count()) === 0;
    record(`${theme} 改回合法值后提示消失`, errGone, `提示${errGone ? '已消失' : '仍存在'}`);

    /* ═══ 7. 留空可提交，且不调用 yield 接口 ═══ */
    await yieldInput(page).fill('');
    await confirmBtn(page).click();
    await page.waitForTimeout(700);
    const createdEmpty = sink.accountWrites.find((w) => w.method === 'POST');
    record(
      `${theme} 留空可提交（账户已建）`,
      !!createdEmpty && createdEmpty.body?.name === '验收-范围校验',
      `POST /api/accounts ${createdEmpty ? '已发出' : '未发出'}`,
    );
    record(
      `${theme} 留空时不调用 yield 接口`,
      sink.yieldCalls.length === 0,
      `yield PUT ${sink.yieldCalls.length} 次（期望 0：留空 ≠ 填 0）`,
    );
    const closedAfterEmpty = (await page.locator('[data-testid="yield-percent-input"]').count()) === 0;
    record(`${theme} 保存成功后模态关闭`, closedAfterEmpty, `模态${closedAfterEmpty ? '已' : '未'}关闭`);

    /* ═══ 8. 填 2.1 → PUT /:id/yields/<当前年> ═══ */
    await openCreateForm(page);
    await fillName(page).fill('验收-填收益率');
    await yieldInput(page).fill('2.1');
    await confirmBtn(page).click();
    await page.waitForTimeout(700);
    const call = sink.yieldCalls[0];
    record(
      `${theme} 填 2.1 → PUT 年收益率`,
      !!call &&
        call.id === NEW_ACCOUNT_ID &&
        call.year === THIS_YEAR &&
        call.body?.yieldPercent === 2.1,
      call
        ? `PUT /api/accounts/${call.id}/yields/${call.year} body=${JSON.stringify(call.body)}`
        : '未发出 yield PUT',
    );
    // 顺序：必须先 POST 拿到 id，再 PUT（新建流程的关键）
    record(
      `${theme} 先存账户再存收益率`,
      sink.accountWrites.some((w) => w.method === 'POST') && sink.yieldCalls.length === 1,
      `账户写 ${sink.accountWrites.length} 次，yield 写 ${sink.yieldCalls.length} 次`,
    );

    /* ═══ 9. 收益率失败不影响账户保存（账户已存成功 + 明确提示） ═══ */
    expectingHttp500 = true; // 下面的 500 是故意的
    await page.unroute('**/api/**');
    await page.route('**/api/**', async (route) => {
      const req = route.request();
      const path = new URL(req.url()).pathname;
      if (req.method() === 'PUT' && /^\/api\/accounts\/\d+\/yields\/\d{4}$/.test(path)) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.fallback();
    });
    await openCreateForm(page);
    await fillName(page).fill('验收-收益率失败');
    await yieldInput(page).fill('3');
    await confirmBtn(page).click();
    await page.waitForSelector('[data-testid="yield-warning"]', { timeout: 10000 });
    const warning = await page.locator('[data-testid="yield-warning"]').innerText();
    const stillOpen = (await page.locator('[data-testid="yield-percent-input"]').count()) > 0;
    record(
      `${theme} 收益率失败不阻断账户保存`,
      warning.includes('账户已保存') && warning.includes('年收益率') && stillOpen,
      `提示「${warning.slice(0, 40)}…」`,
    );
    await page.screenshot({ path: `${SHOTS}/yield-failed-${theme}.png`, fullPage: false });
    expectingHttp500 = false;

    await ctx.close();
  }

  /* ═══ 收尾：console error ═══ */
  record(
    '明暗两轮无 console error / pageerror',
    consoleErrors.length === 0,
    consoleErrors.length ? consoleErrors.slice(0, 3).join(' | ') : '0 条',
  );
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n通过 ${results.length - failed.length}/${results.length}`);
if (failed.length) {
  console.log('失败项：');
  for (const f of failed) console.log(`  ✗ ${f.name} —— ${f.detail}`);
  process.exit(1);
}
console.log(`截图目录：${SHOTS}`);
