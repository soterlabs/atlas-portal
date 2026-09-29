import path from 'path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Unit tests never need the Tailwind/PostCSS pipeline; an inline config stops Vite from
  // loading postcss.config.mjs (which fails to resolve under vitest) when a CSS module is imported.
  css: { postcss: { plugins: [] } },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['**/*.{test,spec}.{ts,tsx}'],
    // e2e/ holds Playwright specs run via `npx playwright test`, not vitest.
    exclude: ['node_modules', '.next', 'dist', '.trigger', 'out', 'e2e'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
    },
  },
});
