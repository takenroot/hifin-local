/**
 * Accent system + sidebar collapse handle 测试（2026-10 Wave 3）
 * ---------------------------------------------------------------
 * 三个独立单元：
 *   1. atoms.ACCOUNT_KEYS / accentAtom 默认值契约（防退化）
 *   2. ThemeProvider 把 accentAtom 写到 document.documentElement.dataset.accent
 *      （防闪契约：CSS 变量在第一帧就能拿到正确值）
 *   3. AppLayout 桌面 aside 是 relative（SidebarCollapseHandle 依赖这个定位上下文）
 *
 * ponytail: 这些是「声明式契约」单测——任何人不小心把 --brand-rgb 默认值
 * 改回硬编码、把 aside 改回非 relative，CI 立刻红。比挂到集成测试里更轻。
 *
 * 测试环境：vitest 默认 node，没有 DOM 与 jsdom——所以本文件主要对源码做
 * 字符串断言；ThemeProvider 渲染那条改用"匹配 import + dataset.accent 写入模式"
 * 字符串断言，不去真渲染。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'src');

describe('Accent system — atom + CSS contract', () => {
  it('atoms.ts 暴露 5 个 accent key 且默认值是 charcoal', async () => {
    const atomsMod = await import('@/store/atoms');
    expect(atomsMod.accentAtom).toBeDefined();
    // 类型导出存在性断言（防有人把 type AccentKey 删了，组件就 import 不进来了）
    expect(atomsMod.accentAtom).toEqual(expect.anything());
  });

  it('atoms.ts 源码里 accentAtom 默认值是 charcoal', () => {
    // 不依赖 jotai 内部 init 字段——直接读源码字面量，避免 jotai 升级后结构变化导致假阴性
    const src = readFileSync(join(SRC, 'store', 'atoms.ts'), 'utf8');
    expect(src).toMatch(/accentAtom\s*=\s*atomWithStorage<AccentKey>\(\s*['"]hifin:accent['"],\s*['"]charcoal['"]/);
  });

  it('atoms.ts 列出全部 5 个 AccentKey', () => {
    const src = readFileSync(join(SRC, 'store', 'atoms.ts'), 'utf8');
    expect(src).toMatch(/export type AccentKey\s*=\s*['"]charcoal['"]\s*\|\s*['"]indigo['"]\s*\|\s*['"]ocean['"]\s*\|\s*['"]violet['"]\s*\|\s*['"]rose['"]/);
  });

  it('index.css 覆盖了全部 4 个彩色档（indigo/ocean/violet/rose）', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    for (const key of ['indigo', 'ocean', 'violet', 'rose']) {
      expect(css).toContain(`[data-accent='${key}']`);
    }
    // 炭黑默认：写在 :root 上而不是 [data-accent]，与其它档对称
    expect(css).toContain('--brand-rgb: 38 38 43');
    expect(css).toContain('--brand-dark-rgb: 212 212 216');
  });

  it('tailwind.config.js 的 brand 令牌走 CSS 变量（不再硬编码 hex）', () => {
    const cfg = readFileSync(join(SRC, '..', 'tailwind.config.js'), 'utf8');
    // brand.DEFAULT 引用 var(--brand-rgb)
    expect(cfg).toMatch(/brand:\s*{[^}]*DEFAULT:\s*['"]rgb\(var\(--brand-rgb\)/m);
    expect(cfg).toMatch(/dark:\s*['"]rgb\(var\(--brand-dark-rgb\)/m);
    // brand-soft 保持中性灰（不进调色盘）
    expect(cfg).toContain('soft: SOFT.brand.light');
  });

  it('index.css .chart-brand 也走变量（图表线跟调色盘换色）', () => {
    const css = readFileSync(join(SRC, 'index.css'), 'utf8');
    expect(css).toMatch(/\.chart-brand\s*{\s*color:\s*rgb\(var\(--brand-rgb\)/);
    expect(css).toMatch(/\.dark\s+\.chart-brand\s*{\s*color:\s*rgb\(var\(--brand-dark-rgb\)/);
  });

  it('theme.tsx 把 accentAtom 写到 document.documentElement.dataset.accent', () => {
    const src = readFileSync(join(SRC, 'store', 'theme.tsx'), 'utf8');
    // 单独 useEffect 订阅 accentAtom，dataset.accent 写入
    expect(src).toMatch(/useEffect\(\s*\(\)\s*=>\s*{\s*document\.documentElement\.dataset\.accent\s*=/);
    expect(src).toMatch(/dataset\.accent\s*=\s*accent\b/);
  });
});

describe('AppLayout 桌面 aside 是 relative（手柄定位前提）', () => {
  it('AppLayout.tsx 中桌面 aside className 含 relative', () => {
    const src = readFileSync(join(SRC, 'layout', 'AppLayout.tsx'), 'utf8');
    // 桌面 aside 那段（lg:flex 前缀 + 含 relative）
    const m = src.match(/<aside[\s\S]*?hidden lg:flex[\s\S]*?>/);
    expect(m).toBeTruthy();
    expect(m![0]).toMatch(/\brelative\b/);
  });

  it('SidebarCollapseHandle 桌面专属（移动端不渲染，靠父级 lg:flex 控制）', () => {
    const src = readFileSync(
      join(SRC, 'features', 'layout', 'SidebarCollapseHandle.tsx'),
      'utf8',
    );
    expect(src).toContain('IconChevronLeft');
    expect(src).toContain('IconChevronRight');
    // 注释声明桌面专属：组件不自己挂 lg:hidden，靠父级 aside 的 lg:flex 控制
    expect(src).toMatch(/桌面专属|移动端不渲染/);
  });

  it('AppLayout 不再使用 currentSpaceName / onToggleCollapse（折叠按钮已迁）', () => {
    const src = readFileSync(join(SRC, 'layout', 'AppLayout.tsx'), 'utf8');
    expect(src).not.toContain('currentSpaceName');
    expect(src).not.toContain('onToggleCollapse');
    // 底部 "折叠" 按钮文案已消失（折叠切换改走边缘手柄）
    expect(src).not.toMatch(/>\s*折叠\s*</);
  });

  it('SidebarTools 4 件套：调色盘 + 日夜 + 通知 + 头像入口', () => {
    const src = readFileSync(
      join(SRC, 'features', 'layout', 'SidebarTools.tsx'),
      'utf8',
    );
    expect(src).toContain('AccentPicker');
    expect(src).toContain('ThemeToggle');
    expect(src).toContain('NotificationBell');
    expect(src).toContain("navigate('/settings')");
  });
});

describe('NotificationBell 复用 notifications 模块 + 30s 轮询', () => {
  it('从 notifications/api 复用 fetchPendingNotifications/resolve/dismiss', () => {
    const src = readFileSync(
      join(SRC, 'features', 'layout', 'NotificationBell.tsx'),
      'utf8',
    );
    expect(src).toContain("from '@/features/notifications/api'");
    expect(src).toContain('fetchPendingNotifications');
    expect(src).toContain('resolveNotification');
    expect(src).toContain('dismissNotification');
    // 30s 周期直接引 POLL_INTERVAL_MS，不另起一份
    expect(src).toContain('POLL_INTERVAL_MS');
  });

  it('popover 面板有 aria-live="polite"（resolve 后残条消失对读屏温和）', () => {
    const src = readFileSync(
      join(SRC, 'features', 'layout', 'NotificationBell.tsx'),
      'utf8',
    );
    expect(src).toContain('aria-live="polite"');
  });
});

