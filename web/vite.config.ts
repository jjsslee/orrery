import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Follows the server's ORRERY_PORT so a dev server can run beside an installed Orrery on 4820.
      '/api': { target: `http://127.0.0.1:${process.env.ORRERY_PORT ?? 4820}`, changeOrigin: true },
    },
  },
  build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
});
