/**
 * Playwright 自检：调色盘 + 侧栏工具排 + 折叠手柄（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 验收项（按用户给的清单）：
 *   1. /home 展开态截图：工具排四件 + 边缘手柄
 *   2. /home 收起态截图：手柄 + icon-only 工具排
 *   3. 暗色截图：data-accent 仍跟随，brand 变浅
 *   4. 调色盘逐档截图：每档截 brand 按钮（hover）颜色
 *   5. 通知面板弹出截图
 *   6. 断言 body[data-accent] 随切换变化
 *
 * 设计：
 *   - 不依赖后端 core，能让页面渲染即可；fetch 失败静默吞掉
 *   - 弹出层（popover）用 evaluate 内的直接 .click() 触发，避开 Playwright 的
 *     "viewport 外点击" 检查（toolbar 在视口底，popover 会自动上翻/下翻）
 *   - 桌面 aside 选择器：aside.lg\\:flex（mobile drawer 是 lg:hidden 不匹配）
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname);
const SHOT_DIR = path.join(ROOT, 'screenshots');
const BASE = process.env.HIFIN_URL || 'http://localhost:5199';
const VIEWPORT = { width: 1440, height: 900 };

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

async function snap(page, name) {
  const file = path.join(SHOT_DIR, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

async function setLocalStorage(page, key, value) {
  // atomWithStorage + createJSONStorage 把 value JSON.stringify 后存进 localStorage。
  // 我们用 UI 触发会让原子正确序列化；测试手工写入时也得模拟这个形态，否则
  // 下次读取 JSON.parse('rose') 抛错、原子回退到 initialValue。
  const encoded = JSON.stringify(value);
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key, encoded]);
}

async function getAccent(page) {
  return page.evaluate(() => document.documentElement.dataset.accent || '');
}

async function gotoFresh(page, url) {
  // 用 location.href 重新加载——避免 page.reload 的偶发缓存
  await page.evaluate((u) => {
    localStorage.setItem('hifin:sidebarCollapsed', 'false');
    window.location.href = u;
  }, url);
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('aside.lg\\:flex', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(500);
}

async function findBrandButton(page) {
  // 找带 bg-brand 的按钮（看板的"记一笔"CTA 在最顶部 hero 区）
  return page.locator('button.bg-brand').first();
}

async function main() {
  ensureDir(SHOT_DIR);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const page = await ctx.newPage();

  const failures = [];

  try {
    // ─── 0. 清空 localStorage 确保初始 ───
    await page.goto(`${BASE}/home`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      localStorage.removeItem('hifin:accent');
      localStorage.removeItem('hifin:theme');
      localStorage.removeItem('hifin:sidebarCollapsed');
    });

    // ─── 1. /home 展开态 ───
    await gotoFresh(page, `${BASE}/home`);
    await snap(page, '01-expanded');
    console.log('[OK] /home 展开态截图');

    const initialAccent = await getAccent(page);
    if (initialAccent !== 'charcoal') {
      failures.push(`初始 accent 不是 'charcoal': got '${initialAccent}'`);
    } else {
      console.log('[OK] 初始 accent = charcoal');
    }

    // 工具排 4 件套存在
    const aside = page.locator('aside.lg\\:flex').first();
    const accentBtnCount = await aside.locator('button[aria-label="切换主题色调色盘"]').count();
    const themeBtnCount = await aside.locator('button[aria-label^="切换主题（"]').count();
    const bellBtnCount = await aside.locator('button[aria-label^="通知"]').count();
    const settingsBtnCount = await aside.locator('button[aria-label="设置"]').count();
    if (accentBtnCount !== 1 || themeBtnCount !== 1 || bellBtnCount !== 1 || settingsBtnCount !== 1) {
      failures.push(`工具排缺件: accent=${accentBtnCount} theme=${themeBtnCount} bell=${bellBtnCount} settings=${settingsBtnCount}`);
    } else {
      console.log('[OK] 工具排 4 件套齐全');
    }

    // 边缘手柄存在
    const handleCount = await aside.locator('button[aria-label="折叠侧边栏"]').count();
    if (handleCount !== 1) {
      failures.push(`边缘手柄（折叠）未找到 (count=${handleCount})`);
    } else {
      console.log('[OK] 边缘手柄存在');
    }

    // ─── 2. /home 收起态 ───
    await aside.locator('button[aria-label="折叠侧边栏"]').click();
    await page.waitForTimeout(300);
    await snap(page, '02-collapsed');
    console.log('[OK] /home 收起态截图');

    const handleAfter = await aside.locator('button[aria-label="展开侧边栏"]').count();
    if (handleAfter !== 1) {
      failures.push(`收起后手柄 aria-label 未翻转为"展开侧边栏" (count=${handleAfter})`);
    } else {
      console.log('[OK] 收起态手柄已翻转');
    }

    // 展开回去
    await aside.locator('button[aria-label="展开侧边栏"]').click();
    await page.waitForTimeout(300);

    // ─── 3. 暗色截图 ───
    await setLocalStorage(page, 'hifin:theme', 'dark');
    await gotoFresh(page, `${BASE}/home`);
    await snap(page, '03-dark');
    console.log('[OK] 暗色截图');

    // ─── 4. 调色盘逐档（关键验收：每档 dataset.accent 都能切换）───
    await setLocalStorage(page, 'hifin:theme', 'light');

    for (const accent of ['charcoal', 'indigo', 'ocean', 'violet', 'rose']) {
      await setLocalStorage(page, 'hifin:accent', accent);
      await gotoFresh(page, `${BASE}/home`);

      const actual = await getAccent(page);
      if (actual !== accent) {
        failures.push(`accent=${accent} 但 dataset.accent=${actual}`);
        continue;
      }

      // hover brand 按钮让颜色更明显，再截
      const btn = await findBrandButton(page);
      if ((await btn.count()) > 0) {
        await btn.hover().catch(() => {});
        await page.waitForTimeout(150);
      }

      await snap(page, `04-accent-${accent}`);
      console.log(`[OK] accent=${accent} 截图`);
    }

    // ─── 5. 通知面板 ───
    // 直接 JS 触发铃铛点击（避开 popover 视口外检查）
    await page.evaluate(() => {
      const aside = document.querySelector('aside.lg\\:flex');
      if (!aside) return;
      const bell = aside.querySelector('button[aria-label*="通知"]');
      if (bell) bell.click();
    });
    await page.waitForTimeout(500);
    await snap(page, '05-notification-popover');
    console.log('[OK] 通知面板截图');

    const popoverCount = await page.locator('div[role="dialog"][aria-label="通知"]').count();
    if (popoverCount !== 1) {
      failures.push(`通知 popover 没出现（count=${popoverCount}）`);
    } else {
      console.log('[OK] 通知 popover 已弹出');
    }
  } catch (e) {
    failures.push(`未捕获异常: ${e && e.message ? e.message : e}`);
  } finally {
    await browser.close();
  }

  if (failures.length > 0) {
    console.error('FAILURES:');
    for (const f of failures) console.error(' - ' + f);
    process.exit(1);
  }
  console.log('\nAll playwright checks passed.');
}

main();
