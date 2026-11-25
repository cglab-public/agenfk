import { describe, it, expect } from 'vitest';
import { agentLabel } from '../agentLabels';

describe('agentLabel', () => {
  it('maps agy to Antigravity', () => {
    expect(agentLabel('agy')).toBe('Antigravity');
  });

  it('falls back to raw id for unknown agents', () => {
    expect(agentLabel('unknown-agent')).toBe('unknown-agent');
  });
});
