import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The renderer is a plain single-page app served by Vite in dev and loaded
// from dist/renderer/index.html (file://) in the packaged app, so every asset
// URL has to stay relative.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [react()],
  server: {
    port: 5273,
    strictPort: false,
  },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    target: 'chrome120',
  },
});
