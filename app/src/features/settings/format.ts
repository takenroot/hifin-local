/**
 * 设置模块内部格式化辅助函数
 *
 * formatMoney 已收敛到 @/lib/format，这里仅 re-export 以保持既有 import 路径不变。
 */
export { formatMoney } from '@/lib/format';

/**
 * 生成 16 位本地用户 ID（首次访问写一次到 kv:userId）。
 * 使用 crypto.randomUUID 截取 + 数字归一化。
 */
export function generateUserId(): string {
  // 取时间戳 + 随机数拼出 16 位十进制
  const t = Date.now().toString(36).slice(-6).toUpperCase();
  const r = Math.floor(Math.random() * 0xffffff)
    .toString(36)
    .padStart(4, '0')
    .toUpperCase()
    .slice(0, 4);
  const s = Math.floor(Math.random() * 0xffff)
    .toString(36)
    .padStart(4, '0')
    .toUpperCase()
    .slice(0, 4);
  // 补足到 16 位
  return (t + r + s).padEnd(16, '0').slice(0, 16);
}

/** 把毫秒时间戳格式化为 yyyy-MM-dd HH:mm */
export function formatDateTime(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 仅日期部分 yyyy-MM-dd */
export function formatDate(ts: number | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}