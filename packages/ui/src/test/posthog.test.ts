import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockInit, mockIdentify, mockCapture, mockRegister } = vi.hoisted(() => ({
  mockInit: vi.fn(),
  mockIdentify: vi.fn(),
  mockCapture: vi.fn(),
  mockRegister: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: {
    init: mockInit,
    identify: mockIdentify,
    capture: mockCapture,
    register: mockRegister,
  },
}));

// Must be imported AFTER the mock is set up
// We use a dynamic re-import per test to reset the `initialized` module state
describe('posthog singleton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules(); // ensures `initialized` resets between tests
  });

  it('capture() is a no-op when not initialized', async () => {
    const { capture } = await import('../posthog');
    capture('test_event');
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('initPosthog() initializes posthog and identifies', async () => {
    const { initPosthog } = await import('../posthog');
    initPosthog('install-id-abc');
    expect(mockInit).toHaveBeenCalledWith(
      'phc_QSEOhekLjn1ZAmwa2Gd43qr6WwaAK8dEhzgoS9XpuXW',
      expect.objectContaining({
        autocapture: false,
        capture_pageview: false,
        person_profiles: 'identified_only',
      })
    );
    expect(mockIdentify).toHaveBeenCalledWith('install-id-abc');
    expect(mockRegister).toHaveBeenCalledWith({ agenfk_version: expect.any(String) });
  });

  it('capture() fires posthog.capture after initialization', async () => {
    const { initPosthog, capture } = await import('../posthog');
    initPosthog('install-id-abc');
    capture('board_viewed', { extra: 'value' });
    expect(mockCapture).toHaveBeenCalledWith('board_viewed', { extra: 'value' });
  });

  it('capture() does not throw if posthog.capture throws', async () => {
    mockCapture.mockImplementationOnce(() => { throw new Error('network'); });
    const { initPosthog, capture } = await import('../posthog');
    initPosthog('install-id-abc');
    expect(() => capture('bad_event')).not.toThrow();
  });

  it('initPosthog() only initializes once even if called twice', async () => {
    const { initPosthog } = await import('../posthog');
    initPosthog('id-1');
    initPosthog('id-2');
    expect(mockInit).toHaveBeenCalledTimes(1);
    expect(mockIdentify).toHaveBeenCalledTimes(1);
  });
});
