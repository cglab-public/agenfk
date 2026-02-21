import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'agenfk',
      include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/dist/**', '**/node_modules/**'],
      environment: 'jsdom', // Some UI tests might need this
    }
  }
]);
