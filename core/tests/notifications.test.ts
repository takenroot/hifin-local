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
