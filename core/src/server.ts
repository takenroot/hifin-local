/**
 * hifin-core REST 服务入口。
 *
 * - createApp(dbPath?) — 构造一个挂好路由 + 中间件的 express 应用（用于测试）
 * - main() — 启动监听 (PORT || 8787)，启动时 migrate + ensureSeed
 *
 * 设计：db 连接由 src/db/connection.ts 的 getDb()/openDatabase() 控制；
 * 启动时如果指定 dbPath 就先打开，否则依赖 connection.ts 内的默认行为。
 */
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { ensureSeed } from './db/seed.js';
import { setActiveDb, getDb } from './routes/_db.js';
import { ensureYieldReminders } from './yields/reminder.js';
import { accountsRouter } from './routes/accounts.js';
import { transactionsRouter } from './routes/transactions.js';
import { summaryRouter } from './routes/summary.js';
import { categoriesRouter } from './routes/categories.js';
import { goalsRouter } from './routes/goals.js';
import { budgetsRouter } from './routes/budgets.js';
import { tagsRouter } from './routes/tags.js';
import { merchantsRouter } from './routes/merchants.js';
import { rulesRouter } from './routes/rules.js';
import { reportsRouter } from './routes/reports.js';
import { spacesRouter } from './routes/spaces.js';
import { kvRouter } from './routes/kv.js';
import { aiModelsRouter } from './routes/ai-models.js';
import { notificationsRouter } from './routes/notifications.js';
import { billsRouter } from './routes/bills.js';

export interface CreateAppOptions {
  /** 已连接的 db 实例；若不传，则视为外部已通过 setDb/openDatabase 准备好 */
  dbPath?: string;
  /** 跳过迁移/seed（测试场景） */
  skipBootstrap?: boolean;
}

export function createApp(opts: CreateAppOptions = {}): Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // 健康检查
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, ts: Date.now() });
  });

  // 业务路由
  app.use('/api/accounts', accountsRouter);
  app.use('/api/transactions', transactionsRouter);
  app.use('/api/summary', summaryRouter);
  app.use('/api/categories', categoriesRouter);
  app.use('/api/goals', goalsRouter);
  app.use('/api/budgets', budgetsRouter);
  app.use('/api/tags', tagsRouter);
  app.use('/api/merchants', merchantsRouter);
  app.use('/api/rules', rulesRouter);
  app.use('/api/reports', reportsRouter);
  app.use('/api/spaces', spacesRouter);
  app.use('/api/kv', kvRouter);
  app.use('/api/ai-models', aiModelsRouter);
  app.use('/api/notifications', notificationsRouter);
  app.use('/api/bills', billsRouter);

  // 404
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: `not found: ${req.method} ${req.path}` });
  });

  // 错误处理
  app.use(
    (err: Error, _req: Request, res: Response, _next: NextFunction): void => {
      // eslint-disable-next-line no-console
      console.error('[server] unhandled error:', err);
      const status =
        err && typeof err === 'object' && 'status' in err
          ? (err as { status: number }).status
          : 500;
      res.status(status).json({ error: err?.message ?? 'internal error' });
    },
  );

  // 触发连接初始化 + migrate/seed（同步，better-sqlite3 无回调）
  // 仅在非 skipBootstrap 模式下打开 + 注入 db；测试场景（skipBootstrap=true）由调用方预先 setActiveDb。
  if (!opts.skipBootstrap) {
    const db = opts.dbPath !== undefined ? openDatabase(opts.dbPath) : openDatabase();
    setActiveDb(db);
    migrate(db);
    ensureSeed(db);
  }

  return app;
}

/** 收益率催填的自检周期：24 小时一次 */
export const YIELD_REMINDER_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * 启动收益率催填调度：立刻跑一次 + 每 24h 一次。
 *
 * 为什么是"立刻 + 周期"而不是只在 1 月 1 号定时：服务器是随开随关的，
 * 只靠固定时刻触发会整个 1 月都漏掉（大部分时候根本没开机）。
 * 靠 ensureYieldReminders 自己的窗口判断 + 幂等去重，随时补跑都是安全的。
 *
 * 单次抛错只打日志不冒泡：催填失败不该把已经监听成功的 HTTP 服务带崩。
 * 返回的 timer 已 unref()，不会吊住进程退出（测试里也不会留下悬挂句柄）。
 */
export function startYieldReminderScheduler(
  db: ReturnType<typeof getDb>,
  intervalMs: number = YIELD_REMINDER_INTERVAL_MS,
): NodeJS.Timeout {
  const tick = (): void => {
    try {
      const run = ensureYieldReminders(db, new Date());
      if (run.created > 0 || run.resolved > 0 || run.expired > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[yields] 催填对账：新建 ${run.created} / 解决 ${run.resolved} / 过期 ${run.expired}` +
            `（缺记录 ${run.missing.length} 个账户）`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[yields] 催填对账失败:', err);
    }
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return timer;
}

function main(): void {
  const port = Number(process.env.PORT) || 8787;
  const dbPath =
    process.env.HIFIN_DB_PATH ?? '/home/saltedfish/project/hifin/core/data/hifin.db';
  const app = createApp({ dbPath });
  // createApp 已经把迁移后的 db 注入了路由层，这里直接复用同一个实例，
  // 不再额外 openDatabase —— 两个连接写同一个文件只会平白多一层锁竞争。
  startYieldReminderScheduler(getDb());
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[hifin-core] listening on http://127.0.0.1:${port} (db=${dbPath})`);
  });
}

// 直接 `node dist/server.js` / `tsx src/server.ts` 时启动；测试时 import createApp 不会触发
const isDirectRun =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('server.ts') || process.argv[1].endsWith('server.js'));
if (isDirectRun) {
  main();
}
