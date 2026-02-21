import { defineWorkspace } from 'vitest/config';
import path from 'path';

export default defineWorkspace([
  {
    test: {
      name: 'ui',
      root: './packages/ui',
      environment: 'jsdom',
      include: ['src/**/*.{test,spec}.{ts,tsx}'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      setupFiles: ['./src/test/setup.ts'],
      globals: true,
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
        '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
      },
    },
  },
  {
    test: {
      name: 'core',
      root: './packages/core',
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
    },
  },
  {
    test: {
      name: 'server',
      root: './packages/server',
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
        '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
      },
    },
  },
  {
    test: {
      name: 'cli',
      root: './packages/cli',
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
        '@agenfk/storage-json': path.resolve(__dirname, './packages/storage-json/src/index.ts'),
      },
    },
  },
  {
    test: {
      name: 'storage-json',
      root: './packages/storage-json',
      environment: 'node',
      include: ['src/**/*.{test,spec}.ts'],
      exclude: ['**/node_modules/**', '**/dist/**'],
      alias: {
        '@agenfk/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      },
    },
  },
]);
