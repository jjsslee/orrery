import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SECURITY_HEADERS } from '../shared/src/security-headers';

export default defineConfig(({ command }) => {
  const nonce = randomBytes(24).toString('base64');
  return {
    plugins: [react()],
    html: command === 'serve' ? { cspNonce: nonce } : undefined,
    server: {
      host: 'localhost',
      port: 5173,
      strictPort: true,
      headers: {
        ...SECURITY_HEADERS,
        'Content-Security-Policy': SECURITY_HEADERS['Content-Security-Policy']
          .replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`)
          .replace("connect-src 'self'", "connect-src 'self' ws://localhost:5173"),
      },
      fs: {
        // A public dev server must never serve the private launcher/token/cache via /@fs/.
        allow: ['./', '../shared', '../node_modules'].map(path => fileURLToPath(new URL(path, import.meta.url))),
        deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.orrery-cache/**'],
      },
      proxy: {
        // Follows the server's ORRERY_PORT so a dev server can run beside an installed Orrery on 4820.
        '/api': { target: `http://127.0.0.1:${process.env.ORRERY_PORT ?? 4820}`, changeOrigin: true },
      },
    },
    build: { sourcemap: false, chunkSizeWarningLimit: 1500 },
  };
});
