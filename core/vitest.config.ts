/**
 * vitest 配置
 *
 * 使用 threads pool 解决 Node 24 + better-sqlite3 11 + vitest 2 在默认 fork 模式下
 * 的 native cleanup hook 冲突（Statement::~Statement → RemoveEnvironmentCleanupHook assert）。
 * threads 模式下 worker 与主进程共享 V8 isolate，不存在退出竞态。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'threads',
  },
});
