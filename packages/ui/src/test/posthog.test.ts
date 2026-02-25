import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInit, mockIdentify, mockCapture } = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockIdentify: vi.fn(),
  mockCapture: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: {
    init: mockInit,
    identify: mockIdentify,
    capture: mockCapture,
  },
}));

// Must be imported AFTER the mock is set up
// We use a dynamic re-import per test to reset the `initialized` module state
describe('posthog singleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // ensures `initialized` resets between tests
    delete (import.meta.env as any).VITE_POSTHOG_KEY;
  });

  it('capture() is a no-op when not initialized', async () => {
    const { capture } = await import('../posthog');
    capture('test_event');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('initPosthog() is a no-op when VITE_POSTHOG_KEY is not set', async () => {
    const { initPosthog, capture } = await import('../posthog');
    initPosthog('install-id-123');
    capture('test_event');
    expect(mockInit).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('initPosthog() initializes posthog and identifies when key is set', async () => {
    (import.meta.env as any).VITE_POSTHOG_KEY = 'phc_testkey';
    const { initPosthog } = await import('../posthog');
    initPosthog('install-id-abc');
    expect(mockInit).toHaveBeenCalledWith('phc_testkey', expect.objectContaining({
      autocapture: false,
      capture_pageview: false,
    }));
    expect(mockIdentify).toHaveBeenCalledWith('install-id-abc');
  });

  it('capture() fires posthog.capture after initialization', async () => {
    (import.meta.env as any).VITE_POSTHOG_KEY = 'phc_testkey';
    const { initPosthog, capture } = await import('../posthog');
    initPosthog('install-id-abc');
    capture('board_viewed', { extra: 'value' });
    expect(mockCapture).toHaveBeenCalledWith('board_viewed', { extra: 'value' });
  });

  it('capture() does not throw if posthog.capture throws', async () => {
    (import.meta.env as any).VITE_POSTHOG_KEY = 'phc_testkey';
    mockCapture.mockImplementationOnce(() => { throw new Error('network'); });
    const { initPosthog, capture } = await import('../posthog');
    initPosthog('install-id-abc');
    expect(() => capture('bad_event')).not.toThrow();
  });

  it('initPosthog() only initializes once even if called twice', async () => {
    (import.meta.env as any).VITE_POSTHOG_KEY = 'phc_testkey';
    const { initPosthog } = await import('../posthog');
    initPosthog('id-1');
    initPosthog('id-2');
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });
});
