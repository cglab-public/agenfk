import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { app, setReleasesUpdateExecImpl, resetReleasesUpdateExecImpl } from '../server';

// We use the dedicated setReleasesUpdateExecImpl injection rather than
// vi.mock('child_process', ...). The latter persists across test files in the
// same vitest worker (even with fileParallelism=false) and breaks unrelated
// tests that import child_process via partial mocks. (Bug 28635f38.)

describe('Server Release Update API', () => {
  let stubExec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    const fakeChild = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn() };
    stubExec = vi.fn(() => fakeChild as any);
    setReleasesUpdateExecImpl(stubExec as any);
  });

  afterEach(() => {
    resetReleasesUpdateExecImpl();
  });

  it('should trigger update with the correct npx command', async () => {
    const res = await request(app).post('/releases/update');
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');

    expect(stubExec).toHaveBeenCalledWith(
      expect.stringContaining('npx -y github:cglab-public/agenfk'),
      expect.any(Object)
    );
  });

  it('uses the injected exec implementation when one is set (defense in depth)', async () => {
    const res = await request(app).post('/releases/update');
    expect(res.status).toBe(202);

    expect(stubExec).toHaveBeenCalledTimes(1);
    expect(stubExec.mock.calls[0][0]).toMatch(/npx -y github:cglab-public\/agenfk/);
  });
});
