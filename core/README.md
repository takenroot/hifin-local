# hifin-core

HiFin 核心服务 — Node 常驻进程，提供 REST API + CLI + IMAP 邮件轮询。

## 架构定位

```
hifin-core (SQLite 唯一数据源)
    ↑ REST API
    ├─ Web SPA (app/) — 未来切换
    ├─ CLI (AI/脚本调用)
    └─ Tauri App (未来内嵌)
```

## 开发

```bash
npm run dev        # tsx watch 启动 REST 服务
npm run test       # vitest
npm run build      # tsc → dist/
```

## CLI 入口

```bash
npx tsx src/cli.ts --help
```
