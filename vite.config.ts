/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    // Rapier's compat build inlines its WASM as base64, so the bundle is
    // large by design; everything is served locally with no CDN.
    chunkSizeWarningLimit: 6000,
  },
  test: {
    // Gameplay rules must run headless, so tests use Node rather than a DOM.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // The design-token tests read the stylesheets' real text (`?raw`).
    css: { include: [/src\/ui\/design\/.+\.css/] },
  },
});
