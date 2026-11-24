// Build of the project cover page (web/cover), separate from the site and from web/og: output in
// .cache/cover-build, which tools/media/cover.mjs serves to a headless browser and saves as
// project_docs/media/cover.png.
//
//   docker compose run --rm -T node npx vite build --config web/cover/vite.config.ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  base: './',
  publicDir: false,
  oxc: { jsx: { runtime: 'automatic', importSource: 'preact' } },
  build: {
    outDir: fileURLToPath(new URL('../../.cache/cover-build', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
});
