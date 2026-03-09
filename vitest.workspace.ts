import { defineWorkspace } from 'vitest/config';
import path from 'path';

export default defineWorkspace([
  {
    resolve: {
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      },
    },
    test: {
      name: 'agenfk',
      include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      environment: 'jsdom',
    }
  }
]);
