/**
 * Semver comparison for the hub — single source of truth lives in @agenfk/core
 * (correct §11 prerelease ordering, with a locale-compare fallback for inputs
 * that don't parse, since the hub stores whatever installations report).
 *
 * Re-exported here so existing hub importers (`../util/semver`) keep working
 * while the implementation is shared with the CLI/server. See semver.test.ts
 * for the behavioral contract this file is expected to satisfy.
 */
export { compareSemver } from '@agenfk/core';

/**
 * Strict semver allowlist for values reported by remote parties (the
 * X-Agenfk-Version batch header, a child hub's hubVersion). Anything not
 * matching is dropped rather than stored, because the value is rendered in
 * the admin UI and feeds version-comparison logic.
 */
export const SEMVER_TAG_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Trimmed value when it is strict semver, otherwise null. */
export function semverOrNull(v: unknown): string | null {
  return typeof v === 'string' && SEMVER_TAG_RE.test(v.trim()) ? v.trim() : null;
}
