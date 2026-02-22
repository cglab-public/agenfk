import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
