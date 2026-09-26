import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          // react 生态
          if (
            id.includes('/node_modules/react/') ||
            id.includes('/node_modules/react-dom/') ||
            id.includes('/node_modules/react-router/') ||
            id.includes('/node_modules/react-router-dom/') ||
            id.includes('/node_modules/@remix-run/router/') ||
            id.includes('/node_modules/scheduler/')
          ) {
            return 'vendor-react';
          }
          // recharts + d3 系
          if (
            id.includes('/node_modules/recharts/') ||
            id.includes('/node_modules/d3-') ||
            id.includes('/node_modules/d3/') ||
            id.includes('/node_modules/victory-vendor/')
          ) {
            return 'vendor-recharts';
          }
          // dexie
          if (
            id.includes('/node_modules/dexie/') ||
            id.includes('/node_modules/dexie-react-hooks/')
          ) {
            return 'vendor-dexie';
          }
          // jotai / icons / dayjs
          if (
            id.includes('/node_modules/jotai/') ||
            id.includes('/node_modules/@tabler/icons-react/') ||
            id.includes('/node_modules/dayjs/')
          ) {
            return 'vendor-utils';
          }
          return undefined;
        },
      },
    },
  },
});