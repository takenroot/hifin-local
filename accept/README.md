# accept/ — 验收产物

本目录存放项目验证相关的产物。

## 目录

```
accept/
├── scripts/                  # Playwright 验证脚本
│   ├── shoot.mjs             # R2 桌面六页截图
│   ├── flow.mjs              # R2 E2E 交互（建账户/建流水/命令面板）
│   ├── dark-check.mjs        # R4 暗黑模式对比度断言
│   ├── fix-check.mjs         # R6 返修自检（⌘K / userId）
│   ├── iter-check.mjs        # R5 五大新模块验证
│   ├── gap-check.mjs         # R6 发现页/天气/移动端综合验证
│   ├── mobile-check.mjs      # R6 移动端 scrollWidth 断言
│   ├── final.mjs             # R6 收尾截图
│   └── ...
└── screenshots/               # 截图（按类型分目录）
    ├── pages/                # 桌面各页面截图
    ├── flows/                # E2E 交互流程截图
    ├── dark/                 # 暗黑模式截图
    ├── iterations/           # R5 新模块截图
    ├── final/                # R6 最终验收截图
    └── mobile/               # 移动端 390px 截图
```

## 运行环境

`accept/scripts/*.mjs` 通过仓库根目录的 `package.json` 引入 Playwright（已装 `playwright@1.55.0`）。

首次运行需安装 Chromium Headless Shell：

```bash
npx playwright install chromium-headless-shell
```

## 运行示例

需先启动 `app` 的 dev server（占用端口 5199）：

```bash
cd app
npm run dev -- --port 5199 --strictPort --host 127.0.0.1 &
```

然后运行任一脚本：

```bash
cd accept/scripts
node gap-check.mjs
```

## 注意

- 脚本运行时会向 `127.0.0.1:5199` 发起请求，需 dev server 在跑
- 截图会写回 `accept/screenshots/<对应子目录>/`
- 不同脚本会在浏览器里操作 IndexedDB（建账户/建流水等），**运行多次会产生数据叠加**