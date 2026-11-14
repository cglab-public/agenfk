/**
 * @vitest-environment jsdom
 *
 * CGLAB-384 (S8-T1) — the hub admin's flow client asks the hub what a draft
 * flow's steps mean, so the shared editor shows roles and checks there too.
 */
import { describe, it, expect, vi } from 'vitest';
import { flowClient } from '../pages/AdminFlows';
import { api } from '../api';

vi.mock('../api', () => ({ api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() } }));

describe('hub flowClient.getFlowContract', () => {
  it('posts the draft steps to the admin contract route and returns its answer', async () => {
    const answer = { valid: true, errors: [], steps: [], roles: [], catalogue: [] };
    vi.mocked(api.post).mockResolvedValue({ data: answer } as never);
    const steps = [{ id: 's0', name: 'todo', label: 'Todo', order: 0, isAnchor: true }];
    expect(await flowClient.getFlowContract!(steps)).toEqual(answer);
    expect(api.post).toHaveBeenCalledWith('/v1/admin/flows/contract', { steps });
  });
});
