/**
 * CGLAB-702 review: a verification URL comes from the hub, so opening it must
 * never pass through a shell, and only http(s) is opened.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { execFile, exec } = vi.hoisted(() => ({ execFile: vi.fn(), exec: vi.fn() }));
vi.mock('child_process', async (orig) => ({ ...(await orig<any>()), execFile, exec }));

import { openUrlInBrowser } from '../openUrl';

beforeEach(() => { execFile.mockReset(); exec.mockReset(); });

describe('openUrlInBrowser', () => {
  it('hands a URL full of shell syntax to the opener as ONE argument, with no shell', () => {
    const evil = 'https://hub.example/connect?code=$(touch /tmp/pwned)`id`&x=1;rm';
    expect(openUrlInBrowser(evil, 'darwin')).toBe(true);
    expect(exec).not.toHaveBeenCalled();
    expect(execFile).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFile.mock.calls[0];
    expect(cmd).toBe('open');
    expect(args).toEqual([new URL(evil).href]);
    expect(opts?.shell).toBeFalsy();
  });

  it('uses xdg-open on Linux and rundll32 (not cmd) on Windows', () => {
    openUrlInBrowser('https://hub.example/a&b', 'linux');
    openUrlInBrowser('https://hub.example/a&b', 'win32');
    expect(execFile.mock.calls[0][0]).toBe('xdg-open');
    expect(execFile.mock.calls[1][0]).toBe('rundll32');
    expect(execFile.mock.calls[1][1]).toEqual(['url.dll,FileProtocolHandler', 'https://hub.example/a&b']);
  });

  it('opens nothing that is not http(s)', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', '--help', 'not a url', 'smb://x/y']) {
      expect(openUrlInBrowser(bad, 'darwin')).toBe(false);
    }
    expect(execFile).not.toHaveBeenCalled();
  });
});
