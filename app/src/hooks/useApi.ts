/**
 * useApi — REST 数据获取 hook（替代 useLiveQuery）
 *
 * 用法：
 *   const { data: accounts, loading, error, refetch } = useApi<Account[]>('/api/accounts');
 *
 * 写操作后手动 refetch() 刷新。空间过滤直接拼 URL：/api/transactions?spaceId=1
 *
 * ── SWR 语义 ──────────────────────────────────────────────
 * 模块级 cache 把「已取过的 URL」留在内存里：
 *  1. 同一 URL 二次挂载（含页面间来回切换）**首帧同步**拿到旧数据，
 *     loading 直接为 false，不会先闪一帧空状态；
 *  2. 命中缓存后仍会后台静默请求，回来后刷新缓存与状态（SWR revalidate）；
 *  3. refetch() 强制拉新并回写缓存；
 *  4. url 为 null 时不查缓存，也不发请求。
 *
 * 缓存不过期、由后台刷新兜底：本项目单表数据量小，代价可接受。
 * 缓存只在请求成功时写入，失败不会污染。
 *
 * loading 的语义是「**当前 url 还没有任何数据可展示**」而不是「有请求在飞」：
 * 拿得到旧数据时保持 false，页面继续渲染旧内容，后台刷新不打断阅读。
 * 同理，请求失败时若手里有旧数据就保留旧数据、只置 error，
 * 避免一次后台刷新失败把整页换成错误页。
 */
import { useState, useEffect, useCallback } from 'react';

export interface UseApiResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

/** 模块级缓存：url → 最近一次成功取回的 JSON。整站共享，SPA 内导航不会丢。 */
const cache = new Map<string, unknown>();

/** 仅供测试重置：清空 SWR 缓存。 */
export function __resetApiCache(): void {
  cache.clear();
}

interface State<T> {
  /** state 归属的 url；与当前 url 不一致说明刚切换过 url，需要回缓存取数 */
  url: string | null;
  data: T | null;
  error: string | null;
}

function initState<T>(url: string | null): State<T> {
  return {
    url,
    data: url ? ((cache.get(url) as T | undefined) ?? null) : null,
    error: null,
  };
}

export function useApi<T>(url: string | null, deps: unknown[] = []): UseApiResult<T> {
  const [state, setState] = useState<State<T>>(() => initState(url));
  // 有缓存就认为「已经能出内容」，首帧不再进入 loading，避免闪空态
  const [inflight, setInflight] = useState(() => url !== null && !cache.has(url));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!url) {
      setState({ url: null, data: null, error: null });
      setInflight(false);
      return;
    }
    // url 变化（切空间 / 换筛选）时先吃新 url 的缓存，别让旧 url 的空态闪一下
    setState((prev) => (prev.url === url ? prev : initState(url)));

    let cancelled = false;
    setInflight(true);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => {
        cache.set(url, d);
        if (cancelled) return;
        setState({ url, data: d as T, error: null });
      })
      .catch((e) => {
        if (cancelled) return;
        setState((prev) => {
          // 手里还有旧数据就留着旧数据，只记录 error（后台刷新失败不该整页翻车）
          if (prev.url === url && prev.data !== null) return prev;
          return { url, data: null, error: String(e) };
        });
      })
      .finally(() => {
        if (!cancelled) setInflight(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, tick, ...deps]);

  // url 与 state.url 不同步的那一帧（切换 url 后的首次渲染）直接从缓存派生，
  // 保证「切回来首帧即有数据」。
  const cached = url ? (cache.get(url) as T | undefined) : undefined;
  const data = state.url === url ? state.data : (cached ?? null);
  const loading = inflight && data === null;

  const refetch = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error: state.error, refetch };
}

/** 写操作 helper：统一错误处理 + 返回 JSON */
export async function apiFetch<T = unknown>(
  url: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<T> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  return r.json() as Promise<T>;
}
