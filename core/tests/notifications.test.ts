/**
 * 通知 store + 通知/账单 REST 路由 + 微信 URL 提取器的测试。
 *
 * 策略与 tests/routes-extra.test.ts 保持一致：
 *  - createApp({ skipBootstrap: true }) + app.listen(0) 拉真实 HTTP，原生 fetch 调用
 *  - 数据库走 :memory:：openDatabase + migrate + setActiveDb 注入路由层
 *  - afterAll 主动 close db，规避 better-sqlite3 native cleanup hook 与 V8 isolate 退出竞态
 *
 * 同一份 :memory: 库在 store 直测与 HTTP 用例间共享，因此用 title 前缀区分数据。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { setActiveDb } from '../src/routes/_db.js';
import {
  createNotification,
  listNotifications,
  getNotification,
  resolveNotification,
  dismissNotification,
  expireNotification,
  incrementRetry,
  parseNotificationPayload,
  NotFoundError,
  NOTIFICATION_TYPES,
  NOTIFICATION_STATUSES,
} from '../src/notifications/store.js';
import { extractWechatDownloadUrl } from '../src/mail/url-extractor.js';
import {
  getBillPassword,
  clearAllBillPasswords,
} from '../src/bill/password-store.js';
import type { NotificationRow } from '../src/db/schema.js';

let memDb: import('better-sqlite3').Database;
let server: Server;
let baseUrl: string;

async function http(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: init.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data: unknown = text.length === 0 ? null : JSON.parse(text);
  return { status: res.status, data };
}

beforeAll(async () => {
  memDb = openDatabase(':memory:');
  setActiveDb(memDb);
  migrate(memDb);

  const { createApp } = await import('../src/server.js');
  const app = createApp({ skipBootstrap: true });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  try {
    memDb?.close();
  } catch {
    /* ignore */
  }
});

// ───────────────────────────── 微信 URL 提取器 ─────────────────────────────

describe('url-extractor: extractWechatDownloadUrl', () => {
  it('提取「立即下载」按钮的直链，并解开 &amp; 实体', () => {
    const html = `
      <html><body>
        <p>尊敬的用户，您的微信支付账单已生成。</p>
        <div class="btn-wrap">
          <a class="btn" target="_blank"
             href="https://dldir1v6.qq.com/weixin/bill/20240512_1234.zip?key=AbC%2Fdef&amp;ticket=xyz">
            <span style="color:#fff;">立即下载</span>
          </a>
        </div>
        <a href="https://weixin110.qq.com/cgi-bin/support?from=mail">帮助中心</a>
      </body></html>`;

    expect(extractWechatDownloadUrl(html)).toBe(
      'https://dldir1v6.qq.com/weixin/bill/20240512_1234.zip?key=AbC%2Fdef&ticket=xyz',
    );
  });

  it('从中转页链接的 url= 参数里挖出真实下载地址', () => {
    const html = `
      <a href="https://weixin110.qq.com/cgi-bin/mmspamsupport-bin/newredirectconfirmcgi?main_type=2&amp;url=https%3A%2F%2Fdldir1v6.qq.com%2Fbill%2Fwechat_20240512.zip%3Fkey%3Dz%26ticket%3Dq">立即下载</a>`;

    expect(extractWechatDownloadUrl(html)).toBe(
      'https://dldir1v6.qq.com/bill/wechat_20240512.zip?key=z&ticket=q',
    );
  });

  it('相对路径用 baseUrl 拼成完整 URL，协议相对链接补 https', () => {
    expect(
      extractWechatDownloadUrl('<a href="/cgi-bin/bill/download?billid=99">立即下载</a>'),
    ).toBe('https://weixin110.qq.com/cgi-bin/bill/download?billid=99');

    expect(
      extractWechatDownloadUrl('<a href="//dldir1v6.qq.com/bill/x.zip">下载账单</a>'),
    ).toBe('https://dldir1v6.qq.com/bill/x.zip');

    // 显式传 baseUrl 时以传入的为准
    expect(
      extractWechatDownloadUrl('<a href="/bill/y.zip">立即下载</a>', 'https://pay.weixin.qq.com'),
    ).toBe('https://pay.weixin.qq.com/bill/y.zip');
  });

  it('href 内含换行/多余空白也能提取（HTML 属性折行）', () => {
    const html = `<a\n  class="btn"\n  href="https://dldir1v6.qq.com/bill/z.zip?a=1&amp;b=2"\n>立即下载</a>`;
    expect(extractWechatDownloadUrl(html)).toBe('https://dldir1v6.qq.com/bill/z.zip?a=1&b=2');
  });

  it('提取不到 / 伪协议 / 空输入一律返回 null', () => {
    expect(extractWechatDownloadUrl('<a href="https://weixin110.qq.com/cgi-bin/support?from=mail">帮助中心</a>')).toBeNull();
    expect(extractWechatDownloadUrl('<p>没有链接的纯文本邮件</p>')).toBeNull();
    expect(extractWechatDownloadUrl('')).toBeNull();
    expect(extractWechatDownloadUrl('<a href="javascript:void(0)">立即下载</a>')).toBeNull();
    expect(extractWechatDownloadUrl('<a>立即下载</a>')).toBeNull();
  });
});

// ───────────────────────────── 通知 store ─────────────────────────────

describe('notifications/store', () => {
  it('createNotification 落库并返回自增 id，默认 pending / retry_count=0', () => {
    const row = createNotification(memDb, {
      type: 'need_password',
      title: '支付宝账单需要解压密码',
      message: '账单 20240512',
      bill_uid: 1811,
      platform: 'alipay',
    });

    expect(row.id).toBeGreaterThan(0);
    expect(row.type).toBe('need_password');
    expect(row.status).toBe('pending');
    expect(row.retry_count).toBe(0);
    expect(row.bill_uid).toBe(1811);
    expect(row.platform).toBe('alipay');
    expect(row.message).toBe('账单 20240512');
    expect(row.createdAt).toBe(row.updatedAt);
  });

  it('createNotification 校验 type / title', () => {
    expect(() =>
      createNotification(memDb, { type: 'nope' as never, title: 'x' }),
    ).toThrow(/type/);
    expect(() => createNotification(memDb, { type: 'need_password', title: '   ' })).toThrow(
      /title/,
    );
  });

  it('listNotifications 支持 status / type 过滤', () => {
    const a = createNotification(memDb, { type: 'need_password', title: 'store: 需要密码 A' });
    createNotification(memDb, { type: 'import_success', title: 'store: 导入成功 B' });
    const c = createNotification(memDb, { type: 'need_password', title: 'store: 需要密码 C' });
    resolveNotification(memDb, a.id as number);

    const pendingPassword = listNotifications(memDb, {
      status: 'pending',
      type: 'need_password',
    });
    const titles = pendingPassword.map((r) => r.title);
    expect(titles).toContain('store: 需要密码 C');
    expect(titles).not.toContain('store: 需要密码 A'); // 已 resolved
    expect(pendingPassword.every((r) => r.status === 'pending' && r.type === 'need_password')).toBe(
      true,
    );

    // 只按 status 过滤时，import_success 的 pending 记录也应命中
    expect(listNotifications(memDb, { status: 'pending' }).length).toBeGreaterThan(1);
    expect(c.status).toBe('pending');
  });

  it('listNotifications 非法过滤值 / limit 抛错', () => {
    expect(() => listNotifications(memDb, { status: 'bogus' as never })).toThrow(/status/);
    expect(() => listNotifications(memDb, { type: 'bogus' as never })).toThrow(/type/);
    expect(() => listNotifications(memDb, { limit: 0 })).toThrow(/limit/);
  });

  it('resolveNotification / dismissNotification 改状态，找不到抛 NotFoundError', () => {
    const r = createNotification(memDb, { type: 'password_error', title: 'store: 密码错误' });
    const id = r.id as number;

    resolveNotification(memDb, id);
    expect(getNotification(memDb, id)?.status).toBe('resolved');

    dismissNotification(memDb, id);
    expect(getNotification(memDb, id)?.status).toBe('dismissed');

    expect(() => resolveNotification(memDb, 999999)).toThrow(NotFoundError);
    expect(() => dismissNotification(memDb, 999999)).toThrow(NotFoundError);
    expect(() => resolveNotification(memDb, 0)).toThrow(/正整数/);
  });

  it('incrementRetry 逐次累加并返回新计数', () => {
    const r = createNotification(memDb, { type: 'need_password', title: 'store: 重试计数' });
    const id = r.id as number;

    expect(incrementRetry(memDb, id)).toBe(1);
    expect(incrementRetry(memDb, id)).toBe(2);
    expect(incrementRetry(memDb, id)).toBe(3);
    expect(getNotification(memDb, id)?.retry_count).toBe(3);
    // 只动计数，不改状态（3 次上限的判定留给状态机）
    expect(getNotification(memDb, id)?.status).toBe('pending');

    expect(() => incrementRetry(memDb, 999999)).toThrow(NotFoundError);
  });

  it('写操作自动维护 updatedAt', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      const r = createNotification(memDb, { type: 'import_failed', title: 'store: 维护 updatedAt' });
      const id = r.id as number;
      expect(r.createdAt).toBe(1_000_000);
      expect(r.updatedAt).toBe(1_000_000);

      nowSpy.mockReturnValue(2_000_000);
      incrementRetry(memDb, id);
      expect(getNotification(memDb, id)?.updatedAt).toBe(2_000_000);
      // createdAt 不被动
      expect(getNotification(memDb, id)?.createdAt).toBe(1_000_000);

      nowSpy.mockReturnValue(3_000_000);
      resolveNotification(memDb, id);
      expect(getNotification(memDb, id)?.updatedAt).toBe(3_000_000);
      expect(getNotification(memDb, id)?.createdAt).toBe(1_000_000);
    } finally {
      nowSpy.mockRestore();
    }
  });

  // ── v3：yield-reminder / expired / payload ──

  it('createNotification 接受 yield-reminder 与 payload 对象', () => {
    const row = createNotification(memDb, {
      type: 'yield-reminder',
      title: 'store: 记一下「零钱通」2025 年的收益率',
      payload: { accountId: 42, year: 2025 },
    });
    expect(row.id).toBeGreaterThan(0);
    expect(row.type).toBe('yield-reminder');
    expect(row.status).toBe('pending');
    expect(row.payload).toBe('{"accountId":42,"year":2025}');
    expect(parseNotificationPayload(row)).toEqual({ accountId: 42, year: 2025 });
  });

  it('payload 缺省 / null 落成 NULL，parse 返回 null', () => {
    const a = createNotification(memDb, { type: 'need_password', title: 'store: 无 payload' });
    expect(a.payload).toBeNull();
    expect(parseNotificationPayload(a)).toBeNull();
    const b = createNotification(memDb, { type: 'need_password', title: 'store: null payload', payload: null });
    expect(b.payload).toBeNull();
  });

  it('parseNotificationPayload 对脏数据一律返回 null（不抛）', () => {
    for (const bad of ['not-json', '', '   ', '[1,2]', '"字符串"', 'null', '42']) {
      expect(parseNotificationPayload({ payload: bad }), `payload=${bad}`).toBeNull();
    }
    expect(parseNotificationPayload({ payload: undefined })).toBeNull();
    expect(parseNotificationPayload({})).toBeNull();
  });

  it('expireNotification 把 pending 收成 expired，找不到抛 NotFoundError', () => {
    const r = createNotification(memDb, { type: 'yield-reminder', title: 'store: 待过期', payload: { accountId: 1, year: 2025 } });
    const id = r.id as number;
    expireNotification(memDb, id);
    expect(getNotification(memDb, id)?.status).toBe('expired');
    // 幂等：再过期一次不报错
    expireNotification(memDb, id);
    expect(getNotification(memDb, id)?.status).toBe('expired');
    expect(() => expireNotification(memDb, 999999)).toThrow(NotFoundError);
  });

  it('NOTIFICATION_TYPES / STATUSES 含新增取值，旧的四个类型仍然合法', () => {
    expect(NOTIFICATION_TYPES).toContain('yield-reminder');
    expect(NOTIFICATION_STATUSES).toContain('expired');
    for (const t of ['need_password', 'password_error', 'import_success', 'import_failed'] as const) {
      expect(NOTIFICATION_TYPES).toContain(t);
      expect(() => createNotification(memDb, { type: t, title: `store: ${t}` })).not.toThrow();
    }
    expect(() => createNotification(memDb, { type: 'yield-reminder', title: 'store: 终态写入' })).not.toThrow();
  });
});

// ───────────────────────────── REST：/api/notifications ─────────────────────────────

describe('REST /api/notifications', () => {
  it('GET 支持 status + type 过滤', async () => {
    const pending = createNotification(memDb, {
      type: 'need_password',
      title: 'http: 待输入密码',
      bill_uid: 2001,
      platform: 'alipay',
    });
    createNotification(memDb, { type: 'import_success', title: 'http: 导入成功' });
    createNotification(memDb, { type: 'need_password', title: 'http: 稍后处理' });

    const { status, data } = await http('/api/notifications?status=pending&type=need_password');
    expect(status).toBe(200);
    const rows = data as NotificationRow[];
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.status === 'pending' && r.type === 'need_password')).toBe(true);
    expect(rows.some((r) => r.title === 'http: 待输入密码')).toBe(true);
    expect(rows.some((r) => r.title === 'http: 导入成功')).toBe(false);

    resolveNotification(memDb, pending.id as number);
  });

  it('GET 非法 status / type 返回 400', async () => {
    const bad = await http('/api/notifications?status=bogus');
    expect(bad.status).toBe(400);
    const bad2 = await http('/api/notifications?type=bogus');
    expect(bad2.status).toBe(400);
    const bad3 = await http('/api/notifications?limit=0');
    expect(bad3.status).toBe(400);
  });

  it('POST /:id/resolve 把通知标记为 resolved', async () => {
    const n = createNotification(memDb, { type: 'need_password', title: 'http: 待 resolve' });
    const id = n.id as number;

    const { status, data } = await http(`/api/notifications/${id}/resolve`, { method: 'POST' });
    expect(status).toBe(200);
    expect((data as NotificationRow).status).toBe('resolved');
    expect((data as NotificationRow).id).toBe(id);

    // 后续列表不再返回
    const after = await http('/api/notifications?status=pending');
    expect((after.data as NotificationRow[]).some((r) => r.id === id)).toBe(false);
  });

  it('POST /:id/dismiss 把通知标记为 dismissed', async () => {
    const n = createNotification(memDb, { type: 'need_password', title: 'http: 待 dismiss' });
    const id = n.id as number;

    const { status, data } = await http(`/api/notifications/${id}/dismiss`, { method: 'POST' });
    expect(status).toBe(200);
    expect((data as NotificationRow).status).toBe('dismissed');
  });

  it('resolve / dismiss 对不存在的 id 返回 404，非法 id 返回 400', async () => {
    expect((await http('/api/notifications/999999/resolve', { method: 'POST' })).status).toBe(404);
    expect((await http('/api/notifications/999999/dismiss', { method: 'POST' })).status).toBe(404);
    expect((await http('/api/notifications/abc/resolve', { method: 'POST' })).status).toBe(400);
    expect((await http('/api/notifications/0/dismiss', { method: 'POST' })).status).toBe(400);
  });
});

// ───────────────────────────── REST：/api/bills ─────────────────────────────

describe('REST /api/bills', () => {
  it('POST /:uid/password 把密码写进内存 PasswordStore', async () => {
    clearAllBillPasswords();

    const { status, data } = await http('/api/bills/1811/password', {
      method: 'POST',
      body: { password: '929143' },
    });
    expect(status).toBe(200);
    expect(data).toEqual({ ok: true });
    expect(getBillPassword(1811)).toBe('929143');

    // 重复提交以最后一次为准
    await http('/api/bills/1811/password', { method: 'POST', body: { password: '999999' } });
    expect(getBillPassword(1811)).toBe('999999');

    clearAllBillPasswords();
  });

  it('uid 非法或 password 为空返回 400，且不写入内存', async () => {
    clearAllBillPasswords();

    expect(
      (await http('/api/bills/abc/password', { method: 'POST', body: { password: '1' } })).status,
    ).toBe(400);
    expect((await http('/api/bills/0/password', { method: 'POST', body: { password: '1' } })).status).toBe(400);
    expect((await http('/api/bills/1812/password', { method: 'POST', body: {} })).status).toBe(400);
    expect(
      (await http('/api/bills/1812/password', { method: 'POST', body: { password: '  ' } })).status,
    ).toBe(400);
    expect(
      (await http('/api/bills/1812/password', { method: 'POST', body: { password: 123 } })).status,
    ).toBe(400);

    expect(getBillPassword(1812)).toBeUndefined();
  });
});

// ───────────────────────────── SSE bus + /stream 路由（v4.1.0 实时通知） ─────────────────────────────

import { afterEach } from 'vitest';
import { publish, subscribe } from '../src/notifications/bus.js';

/**
 * 本段测点对照 docs/sse-design.md §2.5.1：
 *  A. createNotification 触发 'created'
 *  B. resolve / dismiss / expire 各 publish
 *  C. 单个订阅者抛错不影响其它
 *  D. HTTP GET /api/notifications/stream 立即送 hello
 *  E. HTTP 流中 store.publish 能被客户端收到（notification 事件）
 *  F. 客户端断开后订阅者被清理（再创建一次 publish 不影响 / 旧的取消收到）
 *
 * bus 是模块级单例 Set，跨测试会污染；每个测试各自 unsubscribe。
 */
const unsubscribers: Array<() => void> = [];
function trackUnsub(u: () => void): void {
  unsubscribers.push(u);
}
afterEach(() => {
  while (unsubscribers.length > 0) {
    try {
      unsubscribers.pop()?.();
    } catch {
      /* ignore */
    }
  }
});

describe('notifications/bus', () => {
  it('A: createNotification 推一条 {kind:"created", notification:row}', () => {
    const seen: Array<{ kind: string; row?: unknown; id?: number }> = [];
    trackUnsub(
      subscribe((ev) => {
        seen.push({ kind: ev.kind, row: ev.kind === 'created' ? ev.notification : undefined });
      }),
    );

    const row = createNotification(memDb, { type: 'need_password', title: 'bus: 收到' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.kind).toBe('created');
    expect((seen[0]?.row as { id?: number }).id).toBe(row.id);
  });

  it('B: resolve / dismiss / expire 各 publish 对应 kind', () => {
    const created = createNotification(memDb, { type: 'need_password', title: 'bus: 多动作' });
    const id = created.id as number;

    const seen: string[] = [];
    trackUnsub(subscribe((ev) => seen.push(ev.kind)));

    resolveNotification(memDb, id);
    dismissNotification(memDb, id);
    // dismiss 后再 expire：仅为了验证 expired 也走 publish
    expireNotification(memDb, id);

    expect(seen).toEqual(['resolved', 'dismissed', 'expired']);
  });

  it('C: 单个订阅者抛错不影响其它订阅者', () => {
    const seen: string[] = [];
    trackUnsub(subscribe(() => seen.push('good')));
    trackUnsub(subscribe(() => {
      throw new Error('boom');
    }));
    trackUnsub(subscribe(() => seen.push('good2')));

    publish({ kind: 'resolved', id: 1 });
    expect(seen).toEqual(['good', 'good2']);
  });

  it('subscribe 返回的函数真正解绑订阅', () => {
    const seen: string[] = [];
    const u = subscribe((ev) => seen.push(ev.kind));
    publish({ kind: 'resolved', id: 1 });
    expect(seen).toEqual(['resolved']);

    u();
    publish({ kind: 'resolved', id: 2 });
    expect(seen).toEqual(['resolved']);
  });
});

describe('REST GET /api/notifications/stream (SSE)', () => {
  /** 把 SSE 报文按 \n\n 切成单条事件，返回 [{event, data, id?}, ...] */
  function parseSseChunks(buf: string): Array<{ event?: string; id?: string; data?: string }> {
    const out: Array<{ event?: string; id?: string; data?: string }> = [];
    for (const raw of buf.split('\n\n')) {
      const trimmed = raw.replace(/\n$/, '');
      if (!trimmed) continue;
      const ev: { event?: string; id?: string; data?: string } = {};
      for (const line of trimmed.split('\n')) {
        if (line.startsWith(':')) continue; // 注释行 / 心跳
        if (line.startsWith('event:')) ev.event = line.slice(6).trim();
        else if (line.startsWith('id:')) ev.id = line.slice(3).trim();
        else if (line.startsWith('data:')) ev.data = line.slice(5).trim();
      }
      if (ev.event || ev.data) out.push(ev);
    }
    return out;
  }

  /** 异步读 fetch response.body 直到拿到 contains 期望的子串或超时 */
  async function readUntil(
    res: Response,
    predicate: (buf: string) => boolean,
    timeoutMs = 1500,
  ): Promise<string> {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let buf = '';
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const remain = timeoutMs - (Date.now() - t0);
      const { value, done: rdone } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) =>
          setTimeout(() => r({ value: undefined, done: true }), remain),
        ),
      ]);
      if (value) buf += decoder.decode(value, { stream: true });
      if (predicate(buf)) {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        return buf;
      }
      if (rdone) break;
    }
    try {
      await reader.cancel();
    } catch {
      /* noop */
    }
    return buf;
  }

  /**
   * 单 reader 多 read：getReader() 只能调一次，所以聚合多次 readUntil 在一个流上。
   * 返回一个 collect 函数：传入 predicate 与 timeout，等 predicate 命中或超时，
   * 返回那一刻已累积的整段 buffer。
   */
  function streamCollector(res: Response): {
    collect: (predicate: (buf: string) => boolean, timeoutMs?: number) => Promise<string>;
    cancel: () => Promise<void>;
  } {
    const reader = res.body?.getReader();
    if (!reader) throw new Error('no body');
    const decoder = new TextDecoder();
    let buf = '';
    const pump = (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          if (value) buf += decoder.decode(value, { stream: true });
        }
      } catch {
        /* abort / cancel */
      }
    })();
    return {
      collect: async (predicate, timeoutMs = 2000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < timeoutMs) {
          if (predicate(buf)) return buf;
          await new Promise((r) => setTimeout(r, 10));
        }
        return buf;
      },
      cancel: async () => {
        try {
          await reader.cancel();
        } catch {
          /* noop */
        }
        await pump.catch(() => undefined);
      },
    };
  }

  it('D: 立即 flushHeaders，首条事件是 hello（含正确的 Content-Type）', async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ac.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');

    const col = streamCollector(res);
    const buf = await col.collect((b) => b.includes('event: hello'), 2000);
    await col.cancel();
    const events = parseSseChunks(buf);
    expect(events[0]?.event).toBe('hello');
    expect(events[0]?.data).toMatch(/^\{"ts":\d+\}$/);

    ac.abort();
  });

  it('E: 客户端订阅期间 store.createNotification → 收到 notification 事件', async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ac.signal });
    const col = streamCollector(res);

    // 等 hello 出现再触发 store（避免在 hello 之前抢跑）
    await col.collect((b) => b.includes('event: hello'), 2000);

    const created = createNotification(memDb, {
      type: 'need_password',
      title: 'http-stream: 实时收到',
      bill_uid: 20251005,
      platform: 'alipay',
    });
    const targetId = created.id as number;

    const buf = await col.collect(
      (b) => b.includes(`event: notification`) && b.includes(`"id":${targetId}`),
      2000,
    );
    await col.cancel();
    const events = parseSseChunks(buf);
    const notif = events.find((e) => e.event === 'notification');
    expect(notif).toBeDefined();
    expect(notif?.id).toBe(String(targetId));
    const parsed = JSON.parse(notif?.data ?? '{}') as { kind: string; notification: { id: number; title: string } };
    expect(parsed.kind).toBe('created');
    expect(parsed.notification.id).toBe(targetId);
    expect(parsed.notification.title).toBe('http-stream: 实时收到');

    ac.abort();
  });

  it('F: 客户端断开后，服务端不再向该连接推送', async () => {
    const ac1 = new AbortController();
    const res1 = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ac1.signal });
    const col1 = streamCollector(res1);
    await col1.collect((b) => b.includes('event: hello'), 2000);

    // 立刻断开；cleanup 应该清掉订阅
    ac1.abort();
    await col1.cancel();
    // 给事件循环一拍让 req.close 落地
    await new Promise((r) => setTimeout(r, 50));

    // 再开第二个连接，触发 store 写入；断言 res2 能看到
    const ac2 = new AbortController();
    const res2 = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ac2.signal });
    const col2 = streamCollector(res2);
    await col2.collect((b) => b.includes('event: hello'), 2000);

    const created = createNotification(memDb, {
      type: 'need_password',
      title: 'http-stream: 断开后再开',
    });
    const targetId = created.id as number;
    const buf = await col2.collect(
      (b) => b.includes(`event: notification`) && b.includes(`"id":${targetId}`),
      2000,
    );
    await col2.cancel();
    expect(buf).toContain('event: notification');

    ac2.abort();
  });

  it('resolveNotification 推送 resolved 事件，载荷含 id', async () => {
    const ac = new AbortController();
    const res = await fetch(`${baseUrl}/api/notifications/stream`, { signal: ac.signal });
    const col = streamCollector(res);
    await col.collect((b) => b.includes('event: hello'), 2000);

    const created = createNotification(memDb, { type: 'need_password', title: 'http-stream: 待 resolve' });
    const targetId = created.id as number;
    await col.collect((b) => b.includes(`event: notification`), 2000);

    resolveNotification(memDb, targetId);
    const buf = await col.collect(
      (b) => b.includes(`event: resolved`) && b.includes(`"id":${targetId}`),
      2000,
    );
    await col.cancel();
    const events = parseSseChunks(buf);
    const ev = events.find((e) => e.event === 'resolved');
    expect(ev).toBeDefined();
    expect(ev?.id).toBe(String(targetId));
    const parsed = JSON.parse(ev?.data ?? '{}') as { kind: string; id: number };
    expect(parsed.kind).toBe('resolved');
    expect(parsed.id).toBe(targetId);

    ac.abort();
  });
});
