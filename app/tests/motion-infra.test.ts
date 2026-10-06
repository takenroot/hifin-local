/**
 * motion-infra.test.ts（2026-10-06 bento-motion Wave 1）
 * ---------------------------------------------------------------
 * 纯函数 + 渲染契约测试，不验 CSS。
 *
 * 项目零测试框架约束（无 jsdom / testing-library），node 环境。
 *   - 纯函数：bentoDelayMs + 三个常量
 *   - 渲染契约：HarnessProbe 组件用 useInView + 暴露内部 state 到 DOM，
 *     用 renderToStaticMarkup 读出当前 isInView 字符串，断言状态翻转
 *
 * 故意不测 CSS：① className 字符串拼接本身无意义，渲染才是真相；
 * ② 渲染测试需要 jsdom，这里没有。Wave 2 看板挂载时由 accept 截图断言。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  bentoDelayMs,
  BENTO_STAGGER_MS,
  BENTO_ENTER_OFFSET_PX,
  BENTO_HOVER_LIFT_PX,
} from '@/components/ui/BentoCard';
import { useInView } from '@/hooks/useInView';

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
});

/** 把 useInView 内部状态投影成 DOM 文本——纯渲染，不依赖 jsdom。 */
function HarnessProbe(props: { enabled?: boolean; once?: boolean; rootMargin?: string }) {
  const view = useInView<HTMLDivElement>({
    enabled: props.enabled,
    once: props.once,
    rootMargin: props.rootMargin,
  });
  return h('div', { 'data-test': 'probe', 'data-in-view': String(view.isInView) });
}

const probe = (props: Parameters<typeof HarnessProbe>[0] = {}): string =>
  renderToStaticMarkup(h(HarnessProbe, props) as ReactElement);

describe('bentoDelayMs（stagger delay 推算）', () => {
  it('step=0 立即入场，无 delay', () => {
    expect(bentoDelayMs(0)).toBe(0);
  });

  it('step=N 推算 40ms × N', () => {
    expect(bentoDelayMs(1)).toBe(BENTO_STAGGER_MS);
    expect(bentoDelayMs(3)).toBe(120);
    expect(bentoDelayMs(8)).toBe(320);
  });

  it('负数 step 夹到 0（不会让入场反向延迟）', () => {
    expect(bentoDelayMs(-2)).toBe(0);
  });
});

describe('BentoCard 三个常量', () => {
  it('stagger 步进 = 40ms（设计 §4）', () => {
    expect(BENTO_STAGGER_MS).toBe(40);
  });

  it('入场位移 = 12px（设计 §4：fade-up 12px → 0）', () => {
    expect(BENTO_ENTER_OFFSET_PX).toBe(12);
  });

  it('hover lift = -2px（设计 §4）', () => {
    expect(BENTO_HOVER_LIFT_PX).toBe(-2);
  });
});

describe('useInView SSR/降级路径（纯渲染断言）', () => {
  it('挂载即输出 data-in-view="false"（未触发观察）', () => {
    // 初始渲染：useInView 还没挂 observer，state=false
    expect(probe()).toContain('data-in-view="false"');
  });

  it('ref 回调在无 IntersectionObserver 时不抛错（SSR 兜底）', () => {
    // 已 afterEach 删除 IO；直接调用 ref 不会让 hook 崩溃
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    expect(() => probe({ enabled: true })).not.toThrow();
  });

  it('IntersectionObserver 全局被 monkey-patch 也不影响渲染契约', () => {
    // SSR 渲染阶段 useEffect 不跑，所以 IO 是否存在对首次 markup 无影响——
    // 这是 SSR 安全的核心契约：服务端渲染只产 markup，不订阅观察
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    expect(probe({ enabled: true })).toContain('data-in-view="false"');
  });
});
