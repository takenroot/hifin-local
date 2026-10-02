/**
 * 账单解压密码的内存暂存器（邮件 uid → password）
 *
 * 为什么不落盘：微信/支付宝的账单解压密码是"一次性"的（每次申请账单都不同），
 * 写进 SQLite 只会越攒越多过期明文。进程重启即丢，正好符合"密码一次性"的约束。
 *
 * 用法（Web 端 POST 密码时写，poller 解压时读）：
 *     setBillPassword(1811, '******');   // 用户提交
 *     getBillPassword(1811);            // → '******'
 *     clearBillPassword(1811);          // 导入成功后清掉
 *
 * 整个模块只有一个共享 Map；多实例 MailPoller 默认也用它（见 poller.ts），
 * 这样"接口收密码"和"轮询取密码"天然指向同一份内存，不需要绕数据库。
 */

/** 共享的 uid → password 表；进程内唯一，不做任何持久化 */
const billPasswords = new Map<number, string>();

/** uid 归一化：非有限数直接拒绝，避免 NaN 变成一个取不到密码的"幽灵"键 */
function assertUid(uid: number): number {
  if (!Number.isFinite(uid)) {
    throw new Error('uid 必须是数字');
  }
  return Math.trunc(uid);
}

/**
 * 暂存某封账单邮件的解压密码。
 * 同一 uid 重复提交以最后一次为准（用户改密码后重输是常态）。
 */
export function setBillPassword(uid: number, password: string): void {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('解压密码不能为空');
  }
  billPasswords.set(assertUid(uid), password);
}

/** 读取暂存密码；没有则 undefined（绝不返回空串，"没密码"和"空密码"要分得清） */
export function getBillPassword(uid: number): string | undefined {
  if (!Number.isFinite(uid)) return undefined;
  return billPasswords.get(Math.trunc(uid));
}

/** 该 uid 是否已暂存密码 */
export function hasBillPassword(uid: number): boolean {
  if (!Number.isFinite(uid)) return false;
  return billPasswords.has(Math.trunc(uid));
}

/** 清掉某个 uid 的密码（导入成功、或用户放弃时调用） */
export function clearBillPassword(uid: number): void {
  if (!Number.isFinite(uid)) return;
  billPasswords.delete(Math.trunc(uid));
}

/** 当前暂存了密码的 uid 列表（只给状态展示/测试用，别打印密码本身） */
export function listBillPasswordUids(): number[] {
  return [...billPasswords.keys()].sort((a, b) => a - b);
}

/** 暂存密码的条数 */
export function billPasswordCount(): number {
  return billPasswords.size;
}

/**
 * 共享 Map 本身（不是副本）。
 * MailPoller 的 `billPasswords` 选项省略时用它，这样"接口写入 → poller 读出"无需接线。
 */
export function getBillPasswordMap(): Map<number, string> {
  return billPasswords;
}

/** 清空全部暂存密码（登出、切换账户、测试隔离用） */
export function clearAllBillPasswords(): void {
  billPasswords.clear();
}
