/**
 * R8 自定义 Select 验收脚本
 * ---------------------------------------------------------------
 * 验证：
 *   - /settings?section=preferences  语言 Select
 *     · 关闭态截图 r8-lang-closed.png
 *     · 展开态截图 r8-lang-open.png；断言弹层含"简体中文/English（占位）/日本語（占位）"
 *     · 选中第一项后点击外部，触发器显示该文本
 *   - /transaction?create=1  账户 Select（无账户时先建一个）
 *     · 展开截图 r8-account-open.png
 *   - /report/list  报表模板 Select
 *     · 点击"新建报表"，打开模板 Select，截图 r8-report-template.png
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const base = 'http://127.0.0.1:5187';
const screenshotDir = '/home/saltedfish/project/hifin/accept/screenshots/pages';
fs.mkdirSync(screenshotDir, { recursive: true });

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ' — ' + detail : ''}`);
}

/** 创建一个资产账户：跳转 /account/list?create=1，选"现金"类型，下一步，填名称，保存 */
async function ensureAccountExists(page) {
  await page.goto(`${base}/account/list?create=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  // 模态应已打开，先选第一个资产类型（"现金"）
  // TypeOption 按钮含类型 label 文本
  const cashBtn = page
    .locator('button', { hasText: '现金' })
    .filter({ hasNot: page.locator('button[role="combobox"]') })
    .first();
  if (!(await cashBtn.isVisible().catch(() => false))) {
    // 备用：第一个资产类型按钮
    await page.locator('button', { hasText: '银行账户' }).first().click().catch(() => {});
  } else {
    await cashBtn.click();
  }
  await page.waitForTimeout(200);

  // 下一步
  const nextBtn = page.locator('button', { hasText: '下一步' }).first();
  await nextBtn.click();
  await page.waitForTimeout(400);

  // 填名称
  const nameInput = page.locator('input[maxlength="20"]').first();
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill('现金账户');
  } else {
    // 备用：找第一个 input[type=text]
    const firstInput = page.locator('input').first();
    await firstInput.fill('现金账户');
  }
  await page.waitForTimeout(150);

  // 确认
  const confirmBtn = page.locator('button', { hasText: '确认' }).first();
  await confirmBtn.click();
  await page.waitForTimeout(900);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)));

try {
  /* ---------- 1. 语言 Select ---------- */
  await page.goto(`${base}/settings?section=preferences`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);

  const triggers = page.locator('button[role="combobox"]');
  const triggerCount = await triggers.count();
  record('语言页 combobox 数量 >= 2', triggerCount >= 2, `count=${triggerCount}`);

  // 找"语言"那一行 trigger —— 默认语言 = zh-CN，"简体中文"
  const langTrigger = page
    .locator('button[role="combobox"]')
    .filter({ hasText: '简体中文' })
    .first();

  await langTrigger.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({
    path: path.join(screenshotDir, 'r8-lang-closed.png'),
    fullPage: false,
  });
  record('r8-lang-closed.png 已截', true);

  // 展开
  await langTrigger.click();
  await page.waitForTimeout(300);

  const listbox = page.locator('div[role="listbox"]').first();
  const listVisible = await listbox.isVisible().catch(() => false);
  record('语言 listbox 已展开', listVisible);

  const listText = await listbox.textContent().catch(() => '');
  record('弹层含「简体中文」', (listText || '').includes('简体中文'));
  record('弹层含「English（占位）」', (listText || '').includes('English（占位）'));
  record('弹层含「日本語（占位）」', (listText || '').includes('日本語（占位）'));

  await page.screenshot({
    path: path.join(screenshotDir, 'r8-lang-open.png'),
    fullPage: false,
  });
  record('r8-lang-open.png 已截', true);

  // 选中第一项"简体中文"并点击外部触发器显示
  const firstOpt = listbox.locator('button[role="option"]').first();
  await firstOpt.click();
  await page.waitForTimeout(200);

  // 点击外部（页面左上角）
  await page.mouse.click(20, 20);
  await page.waitForTimeout(300);

  const closedListVisible = await page
    .locator('div[role="listbox"]')
    .first()
    .isVisible()
    .catch(() => false);
  record('点击外部后弹层关闭', !closedListVisible);

  // 验证 trigger 显示已选项文本
  const triggerText = await langTrigger.textContent();
  record(
    'trigger 显示简体中文',
    !!triggerText && triggerText.includes('简体中文'),
    `text=${(triggerText || '').slice(0, 40)}`,
  );

  // 键盘 Esc 测试：再打开一次，按 Esc 关闭
  await langTrigger.click();
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  const escClosed = !(await page
    .locator('div[role="listbox"]')
    .first()
    .isVisible()
    .catch(() => false));
  record('Esc 关闭弹层', escClosed);

  /* ---------- 2. 账户 Select（/transaction?create=1） ---------- */
  // 先确保至少有一个账户
  await ensureAccountExists(page);

  // 再回到交易页
  await page.goto(`${base}/transaction?create=1`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 找到"账户" Select —— 在 TransactionFormModal 中它是第二个 combobox
  // (第一个 combobox 是 type Tab 内的 radiogroup 但不是 button[role=combobox])
  // 顺序：分类 -> 账户 -> (转入账户) -> 商户
  // 用 placeholder 文本定位：未选时显示"请选择账户"
  let accountTrigger = page
    .locator('button[role="combobox"]')
    .filter({ hasText: '请选择账户' })
    .first();
  if (!(await accountTrigger.isVisible().catch(() => false))) {
    // 已选账户（显示账户名）—— 取第二个 combobox
    accountTrigger = page.locator('button[role="combobox"]').nth(1);
  }
  const accountVisible = await accountTrigger.isVisible().catch(() => false);
  record('账户 Select trigger 可见', accountVisible);

  await accountTrigger.click();
  await page.waitForTimeout(400);

  const accList = page.locator('div[role="listbox"]').first();
  const optCount = await accList.locator('button[role="option"]').count();
  record('账户弹层有 >=1 选项', optCount >= 1, `count=${optCount}`);

  await page.screenshot({
    path: path.join(screenshotDir, 'r8-account-open.png'),
    fullPage: false,
  });
  record('r8-account-open.png 已截', true);

  // 关闭弹层
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  /* ---------- 3. 报表模板 Select ---------- */
  await page.goto(`${base}/report/list`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);

  // 找到"新建报表"按钮
  const newReportBtn = page.locator('button', { hasText: '新建报表' }).first();
  const newBtnVisible = await newReportBtn.isVisible().catch(() => false);
  if (newBtnVisible) {
    await newReportBtn.click();
    await page.waitForTimeout(800);
  } else {
    const emptyBtn = page.locator('button', { hasText: '新建报表' }).last();
    await emptyBtn.click();
    await page.waitForTimeout(800);
  }

  // ReportFormModal 中第一个 combobox = 数据范围 Select
  const reportTrigger = page.locator('button[role="combobox"]').first();
  const reportTriggerVisible = await reportTrigger.isVisible().catch(() => false);
  record('报表 Select trigger 可见', reportTriggerVisible);

  if (reportTriggerVisible) {
    await reportTrigger.click();
    await page.waitForTimeout(400);
  }
  await page.screenshot({
    path: path.join(screenshotDir, 'r8-report-template.png'),
    fullPage: false,
  });
  record('r8-report-template.png 已截', true);

  console.log('\nPAGE_ERRORS:', JSON.stringify(pageErrors.slice(0, 5)));
} catch (e) {
  console.error('SCRIPT_ERROR:', String(e).slice(0, 400));
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\n=== SUMMARY ===\nPASS: ${passed}  FAIL: ${failed}`);
process.exit(failed > 0 ? 1 : 0);