/**
 * 缺陷修复验收脚本
 *
 * 缺陷1：在 /home 按 Control+K 打开命令面板（断言包含“新建流水”），
 *        再按一次 Control+K 关闭。
 * 缺陷2：在 /settings 断言“本地用户 ID”下方出现非“—”的 ID 字符串。
 *
 * 输出 PASS / FAIL。
 */
import { chromium } from 'playwright';

const BASE = 'http://localhost:5199';

function log(...args) {
  console.log(...args);
}

function fail(msg) {
  console.log('FAIL:', msg);
  process.exitCode = 1;
}

function pass(msg) {
  console.log('PASS:', msg);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200));
});
page.on('pageerror', (e) => consoleErrors.push('PAGEERROR: ' + String(e).slice(0, 200)));

try {
  // ── 缺陷1：⌘K / Ctrl+K ─────────────────────────────────────────────
  await page.goto(BASE + '/home', { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);

  // 第一次按 Ctrl+K：打开命令面板
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);

  let bodyText = await page.textContent('body');
  const opened = bodyText && bodyText.includes('新建流水');
  if (opened) {
    pass('缺陷1: Ctrl+K 打开命令面板（body 含“新建流水”）');
  } else {
    fail('缺陷1: Ctrl+K 后 body 不含“新建流水”');
  }

  // 第二次按 Ctrl+K：关闭命令面板
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);

  bodyText = await page.textContent('body');
  const closed = !(bodyText && bodyText.includes('搜索或输入指令'));
  if (closed) {
    pass('缺陷1: 第二次 Ctrl+K 关闭命令面板');
  } else {
    fail('缺陷1: 第二次 Ctrl+K 后命令面板仍打开');
  }

  // ── 缺陷2：设置页本地用户 ID ──────────────────────────────────────
  await page.goto(BASE + '/settings', { waitUntil: 'networkidle' });
  // 给 useLiveQuery + put + 二次渲染一点时间
  await page.waitForTimeout(1500);

  // 把页面文本拷下来
  const settingsText = (await page.textContent('body')) || '';

  // 找到“本地用户 ID”之后的一段（通常紧跟其后是 input / value），
  // 简单做法：抓页面上所有 input 的 value
  const inputValues = await page.$$eval('input', (els) =>
    els.map((el) => ({ value: el.value, readOnly: el.readOnly })),
  );

  const cardIdx = settingsText.indexOf('本地用户 ID');
  let idString = null;
  if (cardIdx >= 0) {
    // 取“本地用户 ID”之后 200 字符内的可见非“—”文本
    const tail = settingsText.slice(cardIdx, cardIdx + 200);
    // tail 中第一个非空白、非“本地用户 ID”本身、非“—”的字串
    const cleaned = tail
      .replace('本地用户 ID', '')
      .replace(/—/g, '')
      .trim();
    if (cleaned.length > 0) idString = cleaned.split(/\s+/)[0];
  }

  // 同时也允许直接从 input value 推断
  const readonlyIdInput = inputValues.find((v) => v.readOnly && v.value && v.value !== '—');

  const finalId = readonlyIdInput?.value || idString;

  if (finalId && finalId !== '—' && finalId.length > 0) {
    pass(`缺陷2: 设置页“本地用户 ID”已生成：${finalId}`);
  } else {
    fail(
      `缺陷2: 设置页“本地用户 ID”仍为“—”。inputValues=${JSON.stringify(
        inputValues,
      )}, tail=${JSON.stringify(
        settingsText.slice(Math.max(0, cardIdx), cardIdx + 120),
      )}`,
    );
  }

  if (consoleErrors.length > 0) {
    log('控制台错误（非阻塞，仅记录）:');
    for (const e of consoleErrors) log('  ', e);
  }
} catch (e) {
  fail('异常: ' + (e && e.message ? e.message : String(e)));
} finally {
  await browser.close();
}
