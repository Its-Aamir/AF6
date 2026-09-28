import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    host: '127.0.0.1',
    fs: { allow: [path.resolve(here, '..')] },
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.PORT ?? 8787}`, changeOrigin: false } },
  },
  build: { outDir: path.resolve(here, '../dist/web'), emptyOutDir: true, chunkSizeWarningLimit: 1200 },
});
