import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

const apiTarget = process.env.H3MISE_API_TARGET || 'http://127.0.0.1:4789';

// Dev: Vite on 5188, proxying /api to the local H3Mise server (4789).
// Prod: `pnpm --filter @h3mise/web build` and the server serves web/dist.
export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5188,
    // Keep 5188 as the default, but do not bring down the whole dev stack when
    // another H3Mise/Vite instance is already using it. Vite will print the
    // fallback port it selected (5189, 5190, ...).
    strictPort: false,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
