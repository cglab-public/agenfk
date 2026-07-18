const configuredApiUrl = (import.meta.env.VITE_API_URL as string | undefined)?.trim();

/**
 * Use an explicitly configured API origin when provided. Otherwise, keep
 * requests relative so the dashboard works behind a same-origin reverse proxy.
 */
export const API_URL = configuredApiUrl?.replace(/\/+$/, '') ?? '';

