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
        income: {
          DEFAULT: '#ef4444',
          soft: '#fee2e2',
          'soft-dark': 'rgba(239,68,68,0.18)',
        },
        expense: {
          DEFAULT: '#10b981',
          soft: '#d1fae5',
          'soft-dark': 'rgba(16,185,129,0.18)',
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
          soft: '#eef2ff',
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
