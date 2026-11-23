// Build of the Open Graph image pages (web/og), separate from the site: output in .cache/og-build,
// which tools/og/shoot.mjs serves to a headless browser and saves as web/public/og/*.png.
//
//   docker compose run --rm -T node npx vite build --config web/og/vite.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: fileURLToPath(new URL('../../.cache/og-build', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
  server: { fs: { allow: ['..', '../..'] } },
});
