import posthog from 'posthog-js';

declare const __AGENFK_VERSION__: string;

let initialized = false;

const POSTHOG_KEY = 'phc_QSEOhekLjn1ZAmwa2Gd43qr6WwaAK8dEhzgoS9XpuXW';

export function initPosthog(installationId: string): void {
  if (initialized) return;

  posthog.init(POSTHOG_KEY, {
    api_host: 'https://app.posthog.com',
    autocapture: false,
    capture_pageview: false, // We fire board_viewed manually
    person_profiles: 'identified_only',
  });
  posthog.identify(installationId);
  posthog.register({ agenfk_version: __AGENFK_VERSION__ });
  initialized = true;
}

export function capture(event: string, properties?: Record<string, unknown>): void {
  if (!initialized) return;
  try {
    posthog.capture(event, properties);
  } catch {
    // Telemetry must never throw
  }
}
