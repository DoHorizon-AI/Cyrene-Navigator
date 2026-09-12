// ┌─────────────────────────────────────────────────────────────────────┐
// │  📄 vite.config.ts                                                    │
// │  Module: navigator.desktop.vite-config                                │
// │  Role: Configures the Vite development server and frontend output.     │
// │                                                                      │
// │  模块职责：配置 Vite 开发服务器与前端输出                               │
// └─────────────────────────────────────────────────────────────────────┘

import { defineConfig } from 'vite';

export default defineConfig({
  root: 'ui',
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 1420,
    strictPort: true,
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
