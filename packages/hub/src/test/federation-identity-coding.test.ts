import { describe, it, expect } from 'vitest';
import {
  codingFromWire, codingOfRow, legacyPolicyFor, asFieldCoding, AS_WRITTEN,
} from '../services/federation/identityCoding';

const BOTH = { person: 'coded', installation: 'coded' } as const;

describe('asFieldCoding', () => {
  it('accepts only the two field values', () => {
    expect(asFieldCoding('coded')).toBe('coded');
    expect(asFieldCoding('as-written')).toBe('as-written');
    for (const v of ['keep', 'pseudonymize', 'CODED', '', null, undefined, 1, {}]) expect(asFieldCoding(v)).toBeNull();
  });
});

describe('codingFromWire (a child reading its parent)', () => {
  it('takes the per-field shape when the parent sends one, over the binary label beside it', () => {
    expect(codingFromWire({ identity: { person: 'coded', installation: 'as-written' }, identityPolicy: 'pseudonymize' }))
      .toEqual({ person: 'coded', installation: 'as-written' });
  });

  it("reads an older parent's pseudonymize as both fields coded, and keep as neither", () => {
    expect(codingFromWire({ identityPolicy: 'pseudonymize' })).toEqual(BOTH);
    expect(codingFromWire({ identityPolicy: 'keep' })).toEqual(AS_WRITTEN);
  });

  it('codes both fields when the per-field shape is present but incomplete or unrecognised, whatever the binary label says', () => {
    expect(codingFromWire({ identity: { person: 'coded' }, identityPolicy: 'keep' })).toEqual(BOTH);
    expect(codingFromWire({ identity: 'coded', identityPolicy: 'keep' })).toEqual(BOTH);
    expect(codingFromWire({ identity: { person: 'x', installation: 'y' }, identityPolicy: 'anonymous-ish' })).toEqual(BOTH);
  });

  it('says nothing (null) when the parent said nothing it recognises, so the cached value stands', () => {
    expect(codingFromWire({ ok: true })).toBeNull();
    expect(codingFromWire({ identity: null, identityPolicy: 'anonymous-ish' })).toBeNull();
    expect(codingFromWire(null)).toBeNull();
    expect(codingFromWire('pseudonymize')).toBeNull();
  });
});

describe('legacyPolicyFor (what an older parent reads)', () => {
  it('is keep only when nothing is coded', () => {
    expect(legacyPolicyFor(AS_WRITTEN)).toBe('keep');
    expect(legacyPolicyFor({ person: 'coded', installation: 'as-written' })).toBe('pseudonymize');
    expect(legacyPolicyFor({ person: 'as-written', installation: 'coded' })).toBe('pseudonymize');
    expect(legacyPolicyFor(BOTH)).toBe('pseudonymize');
  });
});

describe('codingOfRow (a parent reading a forwarded row)', () => {
  it('takes the per-field shape the row was queued under', () => {
    expect(codingOfRow({ identity: { person: 'as-written', installation: 'coded' }, identityPolicy: 'pseudonymize' }))
      .toEqual({ person: 'as-written', installation: 'coded' });
  });

  it("reads an older child's label: keep is nothing coded, pseudonymize is both", () => {
    expect(codingOfRow({ identityPolicy: 'keep' })).toEqual(AS_WRITTEN);
    expect(codingOfRow({ identityPolicy: 'pseudonymize' })).toEqual(BOTH);
  });

  it('trusts nothing from a row that names no coding it recognises', () => {
    expect(codingOfRow({})).toBeNull();
    expect(codingOfRow({ identityPolicy: 'sure' })).toBeNull();
    expect(codingOfRow({ identity: { person: 'as-written' }, identityPolicy: 'keep' })).toBeNull();
    expect(codingOfRow({ identity: { person: 'as-written', installation: 'nope' }, identityPolicy: 'keep' })).toBeNull();
    expect(codingOfRow(undefined)).toBeNull();
  });
});
