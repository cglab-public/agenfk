import { defineWorkspace } from 'vitest/config';
import path from 'path';

export default defineWorkspace([
  {
    test: {
      name: 'agenfk',
      include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      environment: 'jsdom',
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
        '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
      },
    }
  }
]);