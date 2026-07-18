import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');

describe('package-dist.mjs — ships the UI runtime config', () => {
  it('includes vite.config.ts used by vite preview', () => {
    const packageDist = readFileSync(
      path.join(ROOT, 'scripts', 'package-dist.mjs'),
      'utf8',
    );

    expect(packageDist).toContain("'packages/ui/vite.config.ts'");
  });
});
