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
          dark: '#272a31',
        },
        text: {
          DEFAULT: '#111827',
          dark: '#e5e7eb',
          muted: '#6b7280',
          'muted-dark': '#9ca3af',
        },
        income: {
          DEFAULT: '#10b981',
          soft: '#d1fae5',
          'soft-dark': 'rgba(16,185,129,0.18)',
        },
        expense: {
          DEFAULT: '#ef4444',
          soft: '#fee2e2',
          'soft-dark': 'rgba(239,68,68,0.18)',
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
