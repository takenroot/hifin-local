/**
 * 方向色软底：income / expense / brand 的 soft 与 surface.stat 的方向卡同源。
 * 这里只存一份色值、两处引用，避免同一个底色出现第二份真相。
 * （brand 此前只有 soft 没有 soft-dark，暗色下无法退成色块，本轮补齐。）
 *
 * 键名为什么分开：语义色的键是扁平的 `soft` / `soft-dark`，surface.stat 的键是
 * `brand` / `brand-dark`。两套键名不能靠对象展开合并 —— 展开进来的 `DEFAULT`
 * 会覆盖同名键，把 income.DEFAULT 从金额红顶成浅色底，整站金额跟着变淡。
 */
const SOFT = {
  brand: { light: '#eef2ff', dark: 'rgba(99,102,241,0.18)' },
  income: { light: '#fee2e2', dark: 'rgba(239,68,68,0.18)' },
  expense: { light: '#d1fae5', dark: 'rgba(16,185,129,0.18)' },
};

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 极简浅色 / 暗黑模式柔和配色
        bg: {
          DEFAULT: '#fafafa',
          dark: '#0f1115',
          card: '#ffffff',
          'card-dark': '#171a21',
        },
        border: {
          DEFAULT: '#e5e7eb',
          // 暗黑边框：#272a31 对页面底 #0f1115 仅 1.32:1、对卡片底 #171a21 仅 1.21:1，
          // 全站边框不可见。#5f6875 保持原有冷灰蓝色相（H222°/S12.3%），并同时满足
          // WCAG 2.1 SC 1.4.11 非文本对比度 3:1（较亮的卡片底是紧约束）：
          //   vs #0f1115（页面底）= 3.35:1   vs #171a21（卡片底）= 3.09:1
          dark: '#5f6875',
        },
        text: {
          DEFAULT: '#111827',
          dark: '#e5e7eb',
          muted: '#6b7280',
          'muted-dark': '#9ca3af',
        },
        // 收入=红色（用户直觉），支出=绿色
        // deep 变体：同色加深一档，专供「色块数据卡」（surface.stat）上的大金额文字——
        // 原色在 soft 底上对比度不足（绿 2.24:1 / 红 3.08:1，28px 大字号门槛 3:1），
        // deep 实测 绿 #047857=4.84:1 / 红 #dc2626=3.95:1。白底场景仍用原色（用户约定 hue）。
        income: {
          DEFAULT: '#ef4444',
          deep: '#dc2626',
          soft: SOFT.income.light,
          'soft-dark': SOFT.income.dark,
        },
        expense: {
          DEFAULT: '#10b981',
          deep: '#047857',
          soft: SOFT.expense.light,
          'soft-dark': SOFT.expense.dark,
        },
        // UI 状态轴（2026-10-05 设计审查决策）：与金额语义正交。
        // income/expense 只管钱；破坏性操作/错误/成功走下面三个令牌。
        // danger 取 red-600 #dc2626：比收入红 #ef4444 深一档，同族可辨但 token 独立。
        // 对比度实测（探针口径）：亮色 vs 白底 ≥ 5.9:1 ✓；
        // 暗色纯卡片底 #171a21 仅 3.61:1 —— 暗色正文必须用 danger-dark #f87171（6.29:1），
        // 调用约定：text-danger dark:text-danger-dark（横幅/星号/错误行已全量配对）
        danger: {
          DEFAULT: '#dc2626',
          dark: '#f87171',
          soft: '#fef2f2',
          'soft-dark': 'rgba(220,38,38,0.16)',
        },
        // success 取 green-500 #22c55e：与支出祖母绿 #10b981 错开半档，
        // 避免"成功 toast"与"支出数字"同 hue 混淆；文字场景配 dark 变体
        success: {
          DEFAULT: '#22c55e',
          soft: '#f0fdf4',
          'soft-dark': 'rgba(34,197,94,0.16)',
        },
        warning: {
          DEFAULT: '#d97706',
          soft: '#fffbeb',
          'soft-dark': 'rgba(217,119,6,0.16)',
        },
        brand: {
          DEFAULT: '#6366f1',
          dark: '#a5b4fc',
          soft: SOFT.brand.light,
          'soft-dark': SOFT.brand.dark,
        },
        // 卡片表面分层：站内只有两种卡，语义在此登记，别再各写各的白卡
        //   surface.stat  —— 色块数据卡：软色底 / 无边框 / 圆角 3xl。
        //                    金额主角化用，落地在看板三卡 + 交易页合计卡
        //   surface.panel —— 白卡：圆角 2xl + 边框 + 阴影（index.css 的 .card），样式不动
        // 方向色块与 income/expense/brand 的 soft 同源（见文件顶部 SOFT），
        // 暗色一律走各自 soft-dark，不另开一套。
        surface: {
          stat: {
            DEFAULT: '#f4f4f5',
            dark: '#1c1f26',
            brand: SOFT.brand.light,
            'brand-dark': SOFT.brand.dark,
            income: SOFT.income.light,
            'income-dark': SOFT.income.dark,
            expense: SOFT.expense.light,
            'expense-dark': SOFT.expense.dark,
          },
          panel: { DEFAULT: '#ffffff', dark: '#171a21' },
        },
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
      },
      boxShadow: {
        soft: '0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)',
        'soft-dark': '0 1px 2px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.35)',
      },
      fontFamily: {
        sans: [
          'Inter',
          'system-ui',
          '-apple-system',
          'PingFang SC',
          'Hiragino Sans GB',
          'Microsoft YaHei',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
