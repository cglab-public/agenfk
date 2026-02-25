import posthog from 'posthog-js';

let initialized = false;

export function initPosthog(installationId: string): void {
  const key = import.meta.env.VITE_POSTHOG_KEY as string | undefined;
  if (!key || initialized) return;

  posthog.init(key, {
    api_host: 'https://app.posthog.com',
    autocapture: false,
    capture_pageview: false, // We fire board_viewed manually
    person_profiles: 'never', // Anonymous IDs only — no user profiles
  });
  posthog.identify(installationId);
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
