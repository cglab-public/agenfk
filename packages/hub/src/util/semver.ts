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
