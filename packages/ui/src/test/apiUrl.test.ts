import { afterEach, describe, expect, it, vi } from 'vitest';

describe('API URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to same-origin requests', async () => {
    vi.stubEnv('VITE_API_URL', '');
    const { API_URL } = await import('../apiUrl');

    expect(API_URL).toBe('');
  });

  it('normalizes an explicitly configured API origin', async () => {
    vi.stubEnv('VITE_API_URL', 'https://agenfk-api.example.com///');
    const { API_URL } = await import('../apiUrl');

    expect(API_URL).toBe('https://agenfk-api.example.com');
  });
});
