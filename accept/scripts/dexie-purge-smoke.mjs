/**
 * Dexie 清除收尾 — 4 页冒烟测试
 *
 * 验证前端在移除 Dexie/IndexedDB 依赖后仍能正常从 REST /api/* 取数渲染：
 *   /home（看板） /account/list（账户） /transaction（交易） /settings（设置）
 * 每页收集 console error / pageerror / 失败请求，并断言正文有实际内容渲染。
 *
 * 已知且与本次改动无关的例外：core 的 GET /api/kv/:key 对"未设置"的 key 返回 404
 * （用任意不存在的 key 直连 8787 同样返回 404，属服务端 by-design 行为）。
 * 该 404 在白名单内单独统计，不计入失败；其余任何错误仍然判 FAIL。
 */
import { chromium } from '/home/saltedfish/project/hifin/node_modules/playwright/index.mjs';
import { mkdirSync } from 'node:fs';

const BASE = 'http://127.0.0.1:5187';
const OUT = 'accept/screenshots/dexie-purge';
mkdirSync(OUT, { recursive: true });

/** 已知例外：core 对未设置的 kv key 回 404（服务端行为，非前端 JS 报错） */
const isKnownKvMiss = (s) => /\b404\b.*\/api\/kv\//.test(s);

const PAGES = [
  { path: '/home', name: '看板', shot: '1-dashboard-home.png' },
  { path: '/account/list', name: '账户', shot: '2-accounts-list.png' },
  { path: '/transaction', name: '交易', shot: '3-transactions.png' },
  { path: '/settings', name: '设置', shot: '4-settings.png' },
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });

let failures = 0;
const summary = [];

for (const p of PAGES) {
  const page = await ctx.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];

  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (r) => {
    if (r.status() >= 400) failedReqs.push(`${r.status()} ${r.url()}`);
  });

  await page.goto(BASE + p.path, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(2500);

  // 渲染断言：正文非空 + 有可交互元素
  const dom = await page.evaluate(() => {
    const root = document.querySelector('#root');
    const text = (document.body.innerText || '').trim();
    return {
      rootChildren: root ? root.children.length : 0,
      textLen: text.length,
      sample: text.replace(/\s+/g, ' ').slice(0, 180),
      nodes: document.querySelectorAll('*').length,
    };
  });

  // IndexedDB 不应再被触碰
  const idbUsed = await page.evaluate(async () => {
    if (!('indexedDB' in window)) return false;
    const dbs = await indexedDB.databases?.();
    return Array.isArray(dbs) && dbs.length > 0;
  });

  await page.screenshot({ path: `${OUT}/${p.shot}`, fullPage: false });

  // console 里 kv 404 表现为通用的 "Failed to load resource" 文本，
  // 只能靠同页捕获到的 /api/kv/ 404 数量对齐来判定，其余 console error 一律为意外。
  const kvMisses = failedReqs.filter(isKnownKvMiss).length;
  const unexpectedFails = failedReqs.filter((r) => !isKnownKvMiss(r));
  const unexpectedConsole = consoleErrors.filter(
    (e) => !/Failed to load resource/.test(e),
  );
  // "Failed to load resource" 的总数应与已知的 kv 404 数量一致，多出来的才算问题
  const resourceErrors = consoleErrors.filter((e) =>
    /Failed to load resource/.test(e),
  );
  const extraResourceErrors = Math.max(0, resourceErrors.length - kvMisses);

  const ok =
    dom.rootChildren > 0 &&
    dom.textLen > 50 &&
    unexpectedConsole.length === 0 &&
    pageErrors.length === 0 &&
    unexpectedFails.length === 0 &&
    extraResourceErrors === 0 &&
    idbUsed === false;

  if (!ok) failures++;
  summary.push({
    页面: `${p.name} ${p.path}`,
    结果: ok ? 'PASS' : 'FAIL',
    root子节点: dom.rootChildren,
    DOM节点数: dom.nodes,
    正文长度: dom.textLen,
    正文抽样: dom.sample,
    pageerror: pageErrors,
    意外console错误: unexpectedConsole,
    意外失败请求: unexpectedFails,
    多余资源错误数: extraResourceErrors,
    已知kv404数: kvMisses,
    IndexedDB库: idbUsed ? '仍被创建' : '无',
  });

  await page.close();
}

await browser.close();
console.log(JSON.stringify({ summary, 失败页数: failures }, null, 2));
process.exit(failures === 0 ? 0 : 1);
