import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __AGENFK_VERSION__: JSON.stringify('test'),
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
    coverage: {
      include: ['./src/**'],
      exclude: [
        './src/test/**',
        './src/main.tsx',
        './src/types.ts',
        './src/queryClient.ts',
        './src/assets/**',
        './src/**/*.css',
        './src/**/*.svg',
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
      reporter: ['text', 'json', 'html', 'json-summary'],
    },
  },
});
