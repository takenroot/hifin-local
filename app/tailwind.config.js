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
        brand: {
          DEFAULT: '#6366f1',
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
