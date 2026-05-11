import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('token consumption telemetry removal', () => {
  it('server startup does not start token ingestion or emit tokens.logged hub events', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../server.ts'), 'utf8');

    expect(src).not.toMatch(/startIngestionPoller/);
    expect(src).not.toMatch(/parseClaudeCodeJsonl/);
    expect(src).not.toMatch(/parseCodexJsonl/);
    expect(src).not.toMatch(/tokens\.logged/);
  });
});
