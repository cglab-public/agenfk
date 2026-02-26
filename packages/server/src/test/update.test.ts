import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../server';
import * as child_process from 'child_process';

vi.mock('child_process', () => ({
  exec: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}));

describe('Server Release Update API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should trigger update with the correct npx command', async () => {
    const mockChild = {
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: vi.fn(),
    };
    (child_process.exec as any).mockReturnValue(mockChild);

    const res = await request(app).post('/releases/update');
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('jobId');

    expect(child_process.exec).toHaveBeenCalledWith(
      expect.stringContaining('npx -y github:cglab-PRIVATE/agenfk'),
      expect.any(Object)
    );
  });
});
