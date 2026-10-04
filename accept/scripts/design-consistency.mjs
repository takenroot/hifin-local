/**
 * design-consistency.mjs — 6 列表页设计一致性验收
 * ---------------------------------------------------------------
 * 覆盖本次「6 列表页设计一致性统一」的全部验收点：
 *   1. PageHeader 右上角常驻 primary 按钮（空状态 / 有数据都必须在）
 *   2. 页面内无死按钮图标：svg.tabler-icon-share === 0（IconEye 死按钮同样应为 0）
 *   3. 空状态统一走 EmptyStateCard（.max-w-2xl.mx-auto > .card），
 *      空状态内的引导按钮为 secondary（与右上角 primary 形成主次层级）
 *   4. 卡片网格间距 gap-4（column-gap 16px）
 *   5. 卡片不再使用 hover:shadow-md
 *   6. 内容最大宽度 max-w-[1400px]（1400px）
 *   7. 暗黑模式：html.dark 生效 + 空状态卡片深色背景
 *
 * 数据策略（不污染用户数据）：
 *   - 有数据态：账户/流水用真实默认空间数据；预算/目标/报表临时 POST 一条
 *     fixture（这三张表当前为空，脚本结束时 DELETE 复原）。
 *   - 无数据态：用 Playwright 路由拦截把 /api/{accounts,transactions,budgets,
 *     goals,reports} 全部返回 []，零写入即可拿到 5 个空状态。
 *
 * 用法：node accept/scripts/design-consistency.mjs   （自查端口 5185）
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5185';
const API = process.env.CORE_URL ?? 'http://127.0.0.1:8787';
const SHOTS = 'accept/screenshots/design-consistency';
mkdirSync(SHOTS, { recursive: true });

/* ───────────────────── 页面清单 ───────────────────── */

const PAGES = [
  { key: 'account', path: '/account/list', label: '账户管理', scoped: true, grid: false },
  { key: 'transaction', path: '/transaction', label: '交易流水', scoped: true, grid: false },
  { key: 'budget', path: '/budget', label: '预算管理', scoped: true, grid: true },
  { key: 'goal', path: '/goal/list', label: '目标管理', scoped: true, grid: true },
  { key: 'report', path: '/report/list', label: '数据报表', scoped: true, grid: true },
  // 参考页：不在本次改动范围，只做"无死图标"记录
  { key: 'discover', path: '/discover', label: '发现', scoped: false, grid: false },
];

/* ───────────────────── 结果收集 ───────────────────── */

const results = [];
function record(p, state, theme, name, pass, detail) {
  results.push({ page: p.key, state, theme, name, pass, detail });
}
/** 记录一条"不适用"的断言（如 /discover 无新建动作），不计入失败 */
function skip(p, state, theme, name, detail) {
  results.push({ page: p.key, state, theme, name, pass: true, skipped: true, detail });
}

/* ───────────────────── fixture（可回滚） ───────────────────── */

const created = { budgets: [], goals: [], reports: [] };

async function api(path, method, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
  if (res.status === 204) return null;
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function seedFixtures() {
  const b = await api('/api/budgets', 'POST', {
    name: 'E2E 餐饮预算', period: 'monthly', amount: 2000, categoryId: null, spaceId: 1,
  });
  created.budgets.push(b.id);
  const g = await api('/api/goals', 'POST', {
    kind: 'saving', name: 'E2E 旅行基金', targetAmount: 10000, currentAmount: 2500,
    accountId: null, icon: '✈️', color: '#10b981', spaceId: 1,
  });
  created.goals.push(g.id);
  const r = await api('/api/reports', 'POST', {
    name: 'E2E 月度收支', description: '近 12 月收支趋势（验收 fixture）',
    template: 'monthly', icon: '📊', config: {},
  });
  created.reports.push(r.id);
}

async function dropFixtures() {
  for (const id of created.budgets) await api(`/api/budgets/${id}`, 'DELETE').catch(() => {});
  for (const id of created.goals) await api(`/api/goals/${id}`, 'DELETE').catch(() => {});
  for (const id of created.reports) await api(`/api/reports/${id}`, 'DELETE').catch(() => {});
}

/* ───────────────────── DOM 断言工具 ───────────────────── */

const EMPTY_API = /\/api\/(accounts|transactions|budgets|goals|reports)(\?|$)/;

async function newCtx(browser, { empty, theme }) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(
    ([t]) => {
      localStorage.setItem('hifin:theme', JSON.stringify(t));
      localStorage.setItem('hifin:spaceId', '1');
    },
    [theme],
  );
  if (empty) {
    // 无数据态：列表接口一律返回空数组（不写库）
    await ctx.route('**/api/**', (route) =>
      EMPTY_API.test(new URL(route.request().url()).pathname + new URL(route.request().url()).search)
        ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
        : route.continue(),
    );
  }
  return ctx;
}

async function auditPage(p, state, theme) {
  const ctx = await newCtx(browser, { empty: state === 'empty', theme });
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)));

  await page.goto(BASE + p.path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(900);

  const tag = `${p.label} · ${state === 'empty' ? '无数据' : '有数据'} · ${theme === 'dark' ? '暗黑' : '明亮'}`;

  /* 1. PageHeader 右上角常驻 primary 按钮
     /discover 是只读洞察页，本身没有"新建"动作（且不在本次改动范围），跳过该断言。 */
  const headerBtn = page.locator('header button', { hasText: /新建|添加/ }).first();
  const btnCount = await headerBtn.count();
  if (btnCount === 0) {
    if (p.scoped) {
      record(p, state, theme, 'header-primary-button', false, '右上角未找到含"新建/添加"的按钮');
    } else {
      skip(p, state, theme, 'header-primary-button', 'SKIP：只读洞察页，无新建动作，不在改动范围');
    }
  } else {
    const cls = (await headerBtn.getAttribute('class')) ?? '';
    // 2026-10-05 设计决策：primary 从近黑 bg-text 改为品牌靛蓝 bg-brand
    const isPrimary = /(^|\s)bg-brand(\s|$)/.test(cls) && !/(^|\s)border(\s|$)/.test(cls);
    const text = (await headerBtn.textContent())?.trim() ?? '';
    record(p, state, theme, 'header-primary-button', isPrimary,
      `"${text}" ${isPrimary ? 'primary ✓' : '非 primary ✗ class=' + cls}`);
  }

  /* 2. 无死按钮图标 */
  const share = await page.locator('svg.tabler-icon-share').count();
  record(p, state, theme, 'no-dead-share-icon', share === 0, `tabler-icon-share = ${share}`);
  if (p.scoped) {
    const eye = await page.locator('svg.tabler-icon-eye').count();
    record(p, state, theme, 'no-dead-eye-icon', eye === 0, `tabler-icon-eye = ${eye}`);
  }

  /* 3. 空状态卡片（仅无数据态校验） */
  if (state === 'empty' && p.scoped) {
    const card = page.locator('div.max-w-2xl.mx-auto > div.card');
    const n = await card.count();
    record(p, state, theme, 'empty-state-card', n === 1,
      n === 1 ? 'EmptyStateCard（max-w-2xl 居中）✓' : `EmptyStateCard 数量 = ${n} ✗`);

    if (n === 1) {
      const cta = card.locator('button', { hasText: /新建|添加|导入/ }).first();
      const cls = (await cta.getAttribute('class')) ?? '';
      const isSecondary = /(^|\s)border(\s|$)/.test(cls) && /(^|\s)bg-bg-card(\s|$)/.test(cls);
      record(p, state, theme, 'empty-cta-secondary', isSecondary,
        isSecondary ? '引导按钮 secondary ✓' : '引导按钮非 secondary ✗ class=' + cls);
    }
  }

  /* 4/5/6. 有数据态的布局指标 */
  if (state === 'data' && p.scoped) {
    if (p.grid) {
      const gap = await page.evaluate(() => {
        const g = document.querySelector('div.grid.grid-cols-1');
        return g ? getComputedStyle(g).columnGap : null;
      });
      record(p, state, theme, 'grid-gap-4', gap === '16px', `column-gap = ${gap}（期望 16px）`);
    }
    const shadow = await page.evaluate(() => {
      let hits = 0;
      for (const el of document.querySelectorAll('*')) {
        if (typeof el.className === 'string' && el.className.includes('hover:shadow-md')) hits++;
      }
      return hits;
    });
    record(p, state, theme, 'no-hover-shadow-md', shadow === 0, `hover:shadow-md 元素 = ${shadow}`);

    const maxW = await page.evaluate(() => {
      const el = Array.from(document.querySelectorAll('div')).find((d) =>
        typeof d.className === 'string' && d.className.includes('max-w-[1400px]'),
      );
      return el ? getComputedStyle(el).maxWidth : null;
    });
    record(p, state, theme, 'content-max-w-1400', maxW === '1400px', `max-width = ${maxW}（期望 1400px）`);
  }

  /* 7. 暗黑模式生效校验 */
  if (theme === 'dark') {
    const dark = await page.evaluate(() => ({
      htmlDark: document.documentElement.classList.contains('dark'),
      cardBg: (() => {
        const c = document.querySelector('div.max-w-2xl.mx-auto > div.card');
        return c ? getComputedStyle(c).backgroundColor : null;
      })(),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    }));
    record(p, state, theme, 'dark-mode-applied', dark.htmlDark,
      `html.dark=${dark.htmlDark} body.bg=${dark.bodyBg} 空状态卡片.bg=${dark.cardBg}`);
  }

  record(p, state, theme, 'no-page-error', pageErrors.length === 0,
    pageErrors.length ? pageErrors.slice(0, 2).join(' | ') : '无 JS 报错');

  await page.screenshot({ path: `${SHOTS}/${p.key}-${state}-${theme}.png`, fullPage: false });
  await ctx.close();
  void tag;
}

/* ───────────────────── 主流程 ───────────────────── */

const browser = await chromium.launch();
const allErrors = [];
try {
  await seedFixtures();

  // 明亮模式：空状态 + 有数据
  for (const p of PAGES) {
    await auditPage(p, 'empty', 'light');
    await auditPage(p, 'data', 'light');
  }
  // 暗黑模式：空状态（5 个空状态截图对比）
  for (const p of PAGES) {
    await auditPage(p, 'empty', 'dark');
  }
} catch (e) {
  allErrors.push(String(e).slice(0, 300));
} finally {
  await dropFixtures();
  await browser.close();
}

/* ───────────────────── 报告 ───────────────────── */

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - s.length));
let current = '';
for (const r of results) {
  const key = `${r.page} ${r.state} ${r.theme}`;
  if (key !== current) {
    current = key;
    console.log(`\n── ${key} ──`);
  }
  console.log(`  ${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${pad(r.name, 24)} ${r.detail}`);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n=========== 汇总 ===========`);
console.log(`断言总数: ${results.length}   通过: ${results.length - failed.length}   失败: ${failed.length}`);
if (allErrors.length) console.log('运行异常:', allErrors.join(' | '));
if (failed.length) {
  console.log('失败项:');
  for (const f of failed) console.log(`  - ${f.page}/${f.state}/${f.theme} · ${f.name} · ${f.detail}`);
}
console.log(`截图目录: ${SHOTS}/`);
process.exit(failed.length === 0 && allErrors.length === 0 ? 0 : 1);
