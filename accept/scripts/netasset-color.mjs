/**
 * 回归：金额语义色（2026-10-06 主题还原后口径）
 * ---------------------------------------------------------------
 * 口径（docs/design-principles.md）：
 *   收入=绿、支出=红；好事=绿、坏事=红（涨跌/净资产/余额同此约定）
 * 断言对象：看板三张色块卡的大金额 + 环比行 + 账户管理合计
 *   - 本月收入卡金额 → 绿色系
 *   - 本月支出卡金额 → 红色系
 *   - 净资产卡：行为按 dynamic tone（负数/下跌=红，正数=绿），此处只断言
 *     「渲染出来的 income/expense 类与红绿实际色一致」，防止令牌再次错位
 * 运行：core :8787 + vite :5199 均需在线。
 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://127.0.0.1:5199/home', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

const rows = await page.evaluate(() => {
  const out = [];
  // 色块卡大金额：StatCard 的 valueClass 挂 text-income-deep/text-expense-deep
  document.querySelectorAll('[class*="text-income-deep"], [class*="text-expense-deep"]').forEach((el) => {
    const label = el.parentElement?.parentElement?.textContent?.slice(0, 12) ?? '';
    out.push({
      label,
      cls: String(el.className).match(/text-(income|expense)-deep/)?.[1] ?? '?',
      color: getComputedStyle(el).color,
    });
  });
  return out;
});

function isGreen(rgb) {
  const [, r, g, b] = rgb.match(/rgb\((\d+), (\d+), (\d+)\)/)?.map(Number) ?? [];
  return g > r && g > b;
}
function isRed(rgb) {
  const [, r, g, b] = rgb.match(/rgb\((\d+), (\d+), (\d+)\)/)?.map(Number) ?? [];
  return r > g && r > b;
}

let failed = 0;
for (const row of rows) {
  const ok = row.cls === 'income' ? isGreen(row.color) : isRed(row.color);
  console.log(`${ok ? '✓' : '✗'} ${row.cls.padEnd(7)} ${row.color}  ${row.label}`);
  if (!ok) failed += 1;
}
// 2026-10-06 bento 重构后：净资产 hero 大卡改为炭黑中性大数字（设计 §3），
// 带 income/expense-deep 的只剩收入/支出两张小卡——核心契约是「income=绿/expense=红
// 令牌与实际渲染色一致」，数量下限随结构改为 ≥2
if (rows.length < 2) {
  console.log(`✗ 色块卡大金额只找到 ${rows.length} 个（预期 ≥2）`);
  failed += 1;
}
await browser.close();
if (failed > 0) {
  console.error(`netasset-color: ${failed} 项未过`);
  process.exit(1);
}
console.log('netasset-color: 全部通过（income=绿 / expense=红，令牌与实际色一致）');
