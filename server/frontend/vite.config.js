import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Windows: default "localhost" can bind IPv6-only (::1); browsers on 127.0.0.1 then get "refused".
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    proxy: {
      '/api': {
        // 127.0.0.1 avoids Windows localhost → IPv6 (::1) issues when the API binds IPv4-only
        target: 'http://127.0.0.1:6291',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('error', (err, _req, res) => {
            console.error('[vite proxy]', err.message);
            if (res && !res.headersSent) {
              res.writeHead(502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({
                error: 'Backend unreachable. Is the API running on port 6291?',
                code: 'PROXY_ERROR'
              }));
            }
          });
        }
      }
    }
  }
});
