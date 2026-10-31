/**
 * CGLAB-696 task 4: which image an Airlock machine is made from. Only the
 * policy names one - org-wide, or per project in an override (effectivePolicyFor
 * applies those) - else the AgEnFK base image of this version, published to GHCR
 * per release. Never the repository: the image is root in the machine, and a
 * repository naming its own could undo every protection (user decision
 * 2026-10-30).
 */
import { describe, it, expect } from 'vitest';
import { normalizeAirlockPolicy } from '@agenfk/core';
import { AIRLOCK_BASE_IMAGE, baseImageFor, machineImageFor } from '../airlock/image';

describe('the AgEnFK base image', () => {
  it('is published to GHCR under the cglab-public org', () => {
    expect(AIRLOCK_BASE_IMAGE).toBe('ghcr.io/cglab-public/agenfk-airlock-base');
  });

  it('is tagged with the agenfk version, so a launcher runs the image built with it', () => {
    expect(baseImageFor('2.1.0-beta.6')).toBe('ghcr.io/cglab-public/agenfk-airlock-base:2.1.0-beta.6');
    expect(baseImageFor('2.1.0')).toBe('ghcr.io/cglab-public/agenfk-airlock-base:2.1.0');
  });

  it('refuses a version that would not make an image tag', () => {
    expect(() => baseImageFor('')).toThrow(/version/);
    expect(() => baseImageFor('2.1.0 --net')).toThrow(/version/);
  });
});

describe('machineImageFor', () => {
  const policy = (machineImage?: string) => normalizeAirlockPolicy({ mode: 'enforce', ...(machineImage ? { machineImage } : {}) });

  it('is the policy\'s image when it names one', () => {
    expect(machineImageFor(policy('ghcr.io/acme/airlock:1.2'), '2.1.0')).toEqual({ image: 'ghcr.io/acme/airlock:1.2', source: 'policy' });
  });

  it('is the base image of this version when the policy names none', () => {
    expect(machineImageFor(policy(), '2.1.0')).toEqual({ image: baseImageFor('2.1.0'), source: 'base' });
  });
});
