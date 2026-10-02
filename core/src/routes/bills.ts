/**
 * /api/bills 路由 — 账单密码提交
 * - POST /api/bills/:uid/password {password}  用户在弹窗里输入解压密码后回传
 *
 * 密码是一次性的（见 docs/bill-automation-design.md），不落库：只写进
 * src/bill/password-store.ts 的内存 Map，poller 下一轮重试解压时取走。
 * 本路由只负责校验 + 投递，不直接触发解压（解压由 poller 异步做，避免请求被 unzip 阻塞）。
 */
import { Router, type Request, type Response } from 'express';
import { setBillPassword } from '../bill/password-store.js';

export const billsRouter = Router();

/** POST /api/bills/:uid/password */
billsRouter.post('/:uid/password', (req: Request, res: Response) => {
  const uid = Number(req.params.uid);
  if (!Number.isInteger(uid) || uid <= 0) {
    res.status(400).json({ error: 'uid 必须是正整数（邮件 UID）' });
    return;
  }

  const body = (req.body ?? {}) as { password?: unknown };
  if (typeof body.password !== 'string' || body.password.trim().length === 0) {
    res.status(400).json({ error: 'password 必填且必须是非空字符串' });
    return;
  }

  // 密码按原样保存（账单密码可能含首尾空格，trim 只用于判空）
  setBillPassword(uid, body.password);
  res.json({ ok: true });
});
