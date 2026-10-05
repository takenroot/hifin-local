/**
 * 迁移验收脚本（一次性使用）
 * ---------------------------------------------------------------
 * 复现 docs/ai-insights-design.md 验收命令：
 *   1) cp core/data/hifin.db /tmp/hifin-migrate-check.db
 *   2) 对 /tmp 副本跑 migrate()（v4 → v5）
 *   3) 断言：
 *      - notifications 行数不变
 *      - 新 CHECK 生效：'ai-insight' 可写、垃圾 type 必被拒
 *   4) 跑完删除 /tmp 副本
 *
 * 用法（项目根）：
 *   node accept/scripts/ai-insights-migrate-check.mjs
 *
 * 设计：完全靠 spawn npx tsx 调用 core 的迁移器，不在本脚本里 import 第三方依赖。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const REAL_DB = resolve(ROOT, 'core/data/hifin.db');
const COPY_DB = '/tmp/hifin-migrate-check.db';

if (!existsSync(REAL_DB)) {
  console.error(`[migrate-check] 真实库不存在: ${REAL_DB}`);
  process.exit(1);
}
copyFileSync(REAL_DB, COPY_DB);
console.log(`[migrate-check] 已复制 ${REAL_DB} → ${COPY_DB}`);

const coreCwd = resolve(ROOT, 'core');

function tsxRun(script) {
  const r = spawnSync('npx', ['tsx', '-e', script], {
    cwd: coreCwd,
    encoding: 'utf-8',
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

// 1) 迁移前快照
const snapBefore = tsxRun(
  `import Database from 'better-sqlite3';
   const db = new Database('${COPY_DB}');
   const c = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).c;
   const types = db.prepare('SELECT type FROM notifications GROUP BY type').all().map(r => r.type).sort();
   const uv = db.pragma('user_version', { simple: true });
   console.log(JSON.stringify({ count: c, types, userVersion: uv }));
   db.close();`
);
if (snapBefore.status !== 0) {
  console.error('[migrate-check] 快照脚本失败:', snapBefore.stderr);
  cleanup();
  process.exit(2);
}
const before = JSON.parse(snapBefore.stdout.trim());
console.log(`[migrate-check] 迁移前: ${JSON.stringify(before)}`);

// 2) 跑 migrate
const migrate = tsxRun(
  `import { openDatabase } from '/home/saltedfish/project/hifin/core/src/db/connection.ts';
   import { migrate, getUserVersion, CURRENT_SCHEMA_VERSION } from '/home/saltedfish/project/hifin/core/src/db/migrate.ts';
   const db = openDatabase('${COPY_DB}');
   migrate(db);
   console.log(JSON.stringify({ userVersion: getUserVersion(db), current: CURRENT_SCHEMA_VERSION }));
   db.close();`
);
if (migrate.status !== 0) {
  console.error('[migrate-check] migrate 失败:', migrate.stderr);
  cleanup();
  process.exit(3);
}
const afterMigrate = JSON.parse(migrate.stdout.trim());
console.log(`[migrate-check] 迁移后: ${JSON.stringify(afterMigrate)}`);
if (afterMigrate.userVersion !== afterMigrate.current) {
  console.error(`[migrate-check] ❌ user_version 未到 CURRENT_SCHEMA_VERSION (${afterMigrate.current})`);
  cleanup();
  process.exit(4);
}

// 3) 行数对比 + CHECK 校验
const verify = tsxRun(
  `import Database from 'better-sqlite3';
   const db = new Database('${COPY_DB}');
   const c = (db.prepare('SELECT COUNT(*) AS c FROM notifications').get()).c;
   let aiInsightOk = false;
   let junkRejected = false;
   let junkErr = '';
   const ts = Date.now();
   try {
     db.prepare("INSERT INTO notifications (type, title, status, createdAt, updatedAt, payload) VALUES ('ai-insight', '财务小结', 'pending', ?, ?, '{}')").run(ts, ts);
     aiInsightOk = true;
   } catch (e) { console.error('ai-insight insert:', String(e)); }
   try {
     db.prepare("INSERT INTO notifications (type, title, status, createdAt, updatedAt) VALUES ('junk', 'x', 'pending', 1, 1)").run();
   } catch (e) {
     junkRejected = /CHECK/i.test(String(e.message));
     junkErr = String(e.message).split('\\n')[0];
   }
   console.log(JSON.stringify({ count: c, aiInsightOk, junkRejected, junkErr }));
   db.close();`
);
if (verify.status !== 0) {
  console.error('[migrate-check] 校验脚本失败:', verify.stderr);
  cleanup();
  process.exit(5);
}
const v = JSON.parse(verify.stdout.trim());
console.log(`[migrate-check] 校验: ${JSON.stringify(v)}`);

let failed = false;
if (v.count !== before.count) {
  console.error(`[migrate-check] ❌ 行数变化: ${before.count} → ${v.count}`);
  failed = true;
}
if (!v.aiInsightOk) {
  console.error('[migrate-check] ❌ ai-insight 写入被拒（CHECK 没扩）');
  failed = true;
}
if (!v.junkRejected) {
  console.error('[migrate-check] ❌ 垃圾类型没被 CHECK 拦下');
  failed = true;
}

cleanup();
if (failed) process.exit(6);
console.log('[migrate-check] ✅ 全部断言通过');

function cleanup() {
  for (const f of [COPY_DB, COPY_DB + '-shm', COPY_DB + '-wal']) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
  console.log(`[migrate-check] 已清理 ${COPY_DB}`);
}