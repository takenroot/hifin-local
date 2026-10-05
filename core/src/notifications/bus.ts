/**
 * 通知事件总线：进程内的订阅-广播机制
 * ---------------------------------------------------------------
 * SSE 路由订阅它，store 的 4 个写入函数在落库后 publish。
 *
 * 设计取舍：
 *  - 用 Set 而非 EventEmitter：set 添加/删除是 O(1)，且天然支持去重
 *  - publish 同步遍历：同一进程内订阅者顺序拿到事件，与写入顺序一致（§4.4）
 *  - 单个订阅者抛错用 try/catch 吃掉：失败 = 对端已断，留到心跳/req.close 时清理
 *  - YAGNI：不区分 topic、不做背压、不上队列
 */
import type { NotificationRow } from '../db/schema.js';

export type NotificationEvent =
  | { kind: 'created'; notification: NotificationRow }
  | { kind: 'resolved'; id: number }
  | { kind: 'dismissed'; id: number }
  | { kind: 'expired'; id: number };

export type Subscriber = (ev: NotificationEvent) => void;

const subscribers = new Set<Subscriber>();

/** 注册订阅；返回的函数用于退订。同一 fn 重复注册会被 Set 自动去重 */
export function subscribe(fn: Subscriber): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/** 同步派发到当前所有订阅者；单个抛错不影响其它 */
export function publish(ev: NotificationEvent): void {
  for (const fn of subscribers) {
    try {
      fn(ev);
    } catch {
      /* 单个订阅者抛错不影响其它，留到心跳/req.close 时清理 */
    }
  }
}