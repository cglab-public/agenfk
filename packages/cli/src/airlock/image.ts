/**
 * Which image an Airlock machine is made from (CGLAB-696): the one the policy
 * names - org-wide, or a project override's, which effectivePolicyFor has
 * applied - else the AgEnFK base image built and published to GHCR with this
 * version. Never one the repository names: the image is root in the machine, so
 * whoever chose it could undo every protection the machine applies (user
 * decision 2026-10-30).
 */
import { isAirlockImageRef, type AirlockPolicy } from '@agenfk/core';

export const AIRLOCK_BASE_IMAGE = 'ghcr.io/cglab-public/agenfk-airlock-base';

export type MachineImageSource = 'policy' | 'base';

export function baseImageFor(version: string): string {
  const image = `${AIRLOCK_BASE_IMAGE}:${version}`;
  if (!version || !isAirlockImageRef(image)) throw new Error(`The agenfk version "${version}" does not make an image tag.`);
  return image;
}

export function machineImageFor(policy: AirlockPolicy, version: string): { image: string; source: MachineImageSource } {
  if (policy.machineImage) return { image: policy.machineImage, source: 'policy' };
  return { image: baseImageFor(version), source: 'base' };
}
