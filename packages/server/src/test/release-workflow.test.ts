/**
 * Tests verifying the release workflow is correctly configured.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');
const RELEASE_YML = path.join(ROOT, '.github/workflows/release.yml');

describe('release workflow', () => {
  it('checkout step includes fetch-depth: 0 so git describe can find tags', () => {
    const content = fs.readFileSync(RELEASE_YML, 'utf8');
    expect(content).toContain('fetch-depth: 0');
  });
});
