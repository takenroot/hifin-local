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
import { setActiveDb } from './routes/_db.js';
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

function main(): void {
  const port = Number(process.env.PORT) || 8787;
  const dbPath =
    process.env.HIFIN_DB_PATH ?? '/home/saltedfish/project/hifin/core/data/hifin.db';
  const app = createApp({ dbPath });
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
