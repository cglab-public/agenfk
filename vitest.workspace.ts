import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      include: ['packages/*/src/test/**/*.{test,spec}.{ts,tsx}'],
      environment: 'jsdom',
    }
  }
]);