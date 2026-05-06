import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mock vars so they're available inside vi.mock factory (runs before imports)
const { mockReadFileSync, mockWriteFileSync, mockMkdirSync } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockMkdirSync: vi.fn(),
}));

vi.mock('fs', () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
  default: {
    readFileSync: mockReadFileSync,
    writeFileSync: mockWriteFileSync,
    mkdirSync: mockMkdirSync,
  },
}));

const { mockPostHogCapture, mockPostHogShutdown } = vi.hoisted(() => ({
  mockPostHogCapture: vi.fn(),
  mockPostHogShutdown: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('posthog-node', () => ({
  PostHog: vi.fn(function (this: any) {
    this.capture = mockPostHogCapture;
    this.shutdown = mockPostHogShutdown;
  }),
}));

import * as path from 'path';
import * as os from 'os';
import { TelemetryClient, getInstallationId, isTelemetryEnabled, getInstallSource } from '../index';

const AGENFK_DIR = path.join(os.homedir(), '.agenfk');
const CONFIG_PATH = path.join(AGENFK_DIR, 'config.json');
const INSTALLATION_ID_PATH = path.join(AGENFK_DIR, 'installation-id');
const HUB_CONFIG_PATH = path.join(AGENFK_DIR, 'hub.json');

function setupFs(
  config: object | null,
  installationId: string | null,
  hubConfig: object | null = null,
) {
  mockReadFileSync.mockImplementation((p: unknown) => {
    if (p === CONFIG_PATH) {
      if (config === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(config);
    }
    if (p === INSTALLATION_ID_PATH) {
      if (installationId === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return installationId;
    }
    if (p === HUB_CONFIG_PATH) {
      if (hubConfig === null) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return JSON.stringify(hubConfig);
    }
    return '';
  });
}

describe('TelemetryClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPostHogShutdown.mockResolvedValue(undefined);
  });

  describe('when telemetry is enabled (default)', () => {
    beforeEach(() => {
      setupFs({}, 'install-abc-123');
    });

    it('isEnabled is true', () => {
      const client = new TelemetryClient();
      expect(client.isEnabled).toBe(true);
    });

    it('exposes the installation ID', () => {
      const client = new TelemetryClient();
      expect(client.id).toBe('install-abc-123');
    });

    it('capture() calls posthog.capture with correct shape', () => {
      const client = new TelemetryClient();
      client.capture('item_created', { itemType: 'TASK' });
      expect(mockPostHogCapture).toHaveBeenCalledWith({
        distinctId: 'install-abc-123',
        event: 'item_created',
        properties: {
          itemType: 'TASK',
          $lib: 'agenfk',
          agenfk_version: expect.any(String),
          install_source: 'local',
        },
      });
    });

    it('capture() does not throw if posthog.capture throws', () => {
      mockPostHogCapture.mockImplementationOnce(() => { throw new Error('network error'); });
      const client = new TelemetryClient();
      expect(() => client.capture('bad_event')).not.toThrow();
    });

    it('capture() with no properties only adds $lib', () => {
      const client = new TelemetryClient();
      client.capture('server_started');
      expect(mockPostHogCapture).toHaveBeenCalledWith({
        distinctId: 'install-abc-123',
        event: 'server_started',
        properties: {
          $lib: 'agenfk',
          agenfk_version: expect.any(String),
          install_source: 'local',
        },
      });
    });

    it('capture() includes install_source: "hub" when ~/.agenfk/hub.json exists', () => {
      setupFs({}, 'install-abc-123', { url: 'https://hub.example.com', token: 't', orgId: 'o' });
      const client = new TelemetryClient();
      client.capture('item_created', { itemType: 'TASK' });
      expect(mockPostHogCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ install_source: 'hub' }),
        }),
      );
    });

    it('capture() does not let caller-supplied properties overwrite install_source', () => {
      const client = new TelemetryClient();
      client.capture('item_created', { install_source: 'spoofed' as unknown as string });
      expect(mockPostHogCapture).toHaveBeenCalledWith(
        expect.objectContaining({
          properties: expect.objectContaining({ install_source: 'local' }),
        }),
      );
    });

    it('shutdown() calls posthog.shutdown()', async () => {
      const client = new TelemetryClient();
      await client.shutdown();
      expect(mockPostHogShutdown).toHaveBeenCalled();
    });

    it('shutdown() does not throw if posthog.shutdown throws', async () => {
      mockPostHogShutdown.mockRejectedValueOnce(new Error('flush error'));
      const client = new TelemetryClient();
      await expect(client.shutdown()).resolves.toBeUndefined();
    });
  });

  describe('when telemetry is opted out via config', () => {
    beforeEach(() => {
      setupFs({ telemetry: false }, 'install-abc-123');
    });

    it('isEnabled is false', () => {
      const client = new TelemetryClient();
      expect(client.isEnabled).toBe(false);
    });

    it('capture() is a no-op', () => {
      const client = new TelemetryClient();
      client.capture('test_event');
      expect(mockPostHogCapture).not.toHaveBeenCalled();
    });
  });
});

describe('getInstallationId', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns trimmed existing ID when file exists', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === INSTALLATION_ID_PATH) return '  existing-id  ';
      return '';
    });
    expect(getInstallationId()).toBe('existing-id');
  });

  it('creates and returns a new UUID when file does not exist', () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockReturnValue(undefined);

    const id = getInstallationId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(mockWriteFileSync).toHaveBeenCalledWith(INSTALLATION_ID_PATH, id, 'utf8');
  });

  it('returns a UUID even if writeFileSync fails', () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('ENOENT'); });
    mockMkdirSync.mockReturnValue(undefined);
    mockWriteFileSync.mockImplementation(() => { throw new Error('permission denied'); });

    expect(() => getInstallationId()).not.toThrow();
    const id = getInstallationId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('getInstallSource', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns "hub" when ~/.agenfk/hub.json exists', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === HUB_CONFIG_PATH) return JSON.stringify({ url: 'https://hub.example.com', token: 't', orgId: 'o' });
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(getInstallSource()).toBe('hub');
  });

  it('returns "local" when ~/.agenfk/hub.json is missing', () => {
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(getInstallSource()).toBe('local');
  });

  it('returns "local" when ~/.agenfk/hub.json is corrupt', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === HUB_CONFIG_PATH) return '{not-json';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    expect(getInstallSource()).toBe('local');
  });
});

describe('isTelemetryEnabled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when config has no telemetry field', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === CONFIG_PATH) return '{}';
      return '';
    });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns false when config sets telemetry: false', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === CONFIG_PATH) return JSON.stringify({ telemetry: false });
      return '';
    });
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('returns true when config sets telemetry: true', () => {
    mockReadFileSync.mockImplementation((p: unknown) => {
      if (p === CONFIG_PATH) return JSON.stringify({ telemetry: true });
      return '';
    });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('returns true when config file is missing', () => {
    mockReadFileSync.mockImplementation(() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); });
    expect(isTelemetryEnabled()).toBe(true);
  });
});
