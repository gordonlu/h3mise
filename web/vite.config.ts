import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// Dev: Vite on 5173, proxying /api to the local H3Mise server (4789).
// Prod: `pnpm --filter @h3mise/web build` and the server serves web/dist.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4789',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
