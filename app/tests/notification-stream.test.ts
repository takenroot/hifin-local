/**
 * 通知 SSE 客户端纯函数测试
 * ---------------------------------------------------------------
 * 覆盖 docs/sse-design.md §2.5.2 的测点 F / G：
 *  - nextBackoff  退避序列正确（1s, 2s, 4s, 8s, 16s, 30s, 30s...）
 *  - upsertById   已有 id in-place 替换；新 id unshift；顺序保持
 *
 * openNotificationStream 的副作用放在 core 端测覆盖（同一份 bus + store），
 * 这里只测纯函数。
 */
import { describe, it, expect } from 'vitest';
import { nextBackoff, upsertById } from '@/features/notifications/stream';
import type { AppNotification } from '@/features/notifications/types';

const CFG = { initialMs: 1000, maxMs: 30000, factor: 2 };

/** 构造一条测试通知：复用真实 toNotification 之外的字段，最小够用 */
function makeN(id: number, title = '通知'): AppNotification {
  return {
    id,
    type: 'need_password',
    title,
    message: '',
    platform: 'alipay',
    status: 'pending',
    retryCount: 0,
    createdAt: id * 1000,
    updatedAt: id * 1000,
  };
}

describe('nextBackoff', () => {
  it('attempts=0 → initialMs', () => {
    expect(nextBackoff(0, CFG)).toBe(1000);
  });

  it('attempts=5 → 1*2^5=32000 上限 → 30000', () => {
    expect(nextBackoff(5, CFG)).toBe(30000);
  });

  it('attempts=10 → 永远 ≤ maxMs', () => {
    expect(nextBackoff(10, CFG)).toBe(30000);
  });

  it('序列单调递增到上限', () => {
    const seq = [0, 1, 2, 3, 4, 5, 6].map((a) => nextBackoff(a, CFG));
    // 1s, 2s, 4s, 8s, 16s, 30s（32000 上限）, 30s
    expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it('自定义 cfg 也按公式生效', () => {
    expect(nextBackoff(2, { initialMs: 500, maxMs: 5000, factor: 3 })).toBe(4500);
    expect(nextBackoff(5, { initialMs: 500, maxMs: 5000, factor: 3 })).toBe(5000);
  });
});

describe('upsertById', () => {
  it('新 id → unshift 到队首，原列表顺序保持', () => {
    const a = makeN(1, 'a');
    const b = makeN(2, 'b');
    const list = [a, b];
    const c = makeN(3, 'c');
    expect(upsertById(list, c)).toEqual([c, a, b]);
  });

  it('已有 id → in-place 替换，其它位置不动', () => {
    const a = makeN(1, 'a-原');
    const b = makeN(2, 'b');
    const c = makeN(3, 'c');
    const list = [a, b, c];
    const aNew = makeN(1, 'a-新');
    const result = upsertById(list, aNew);
    expect(result).toEqual([aNew, b, c]);
    // 返回新数组，原数组不被改
    expect(list[0]?.title).toBe('a-原');
    expect(result).not.toBe(list);
  });

  it('同一 id 已在第一位 → 仍按 in-place 替换', () => {
    const a = makeN(7, 'old');
    const b = makeN(8, 'b');
    const aNew = makeN(7, 'new');
    const result = upsertById([a, b], aNew);
    expect(result).toEqual([aNew, b]);
  });

  it('空列表也能 unshift', () => {
    const n = makeN(1);
    expect(upsertById([], n)).toEqual([n]);
  });

  it('新对象不与列表项共享引用', () => {
    const a = makeN(1, 'a');
    const list = [a];
    const aNew = makeN(1, 'a-new');
    const result = upsertById(list, aNew);
    expect(result[0]).toBe(aNew);
    expect(result[0]).not.toBe(a);
  });
});