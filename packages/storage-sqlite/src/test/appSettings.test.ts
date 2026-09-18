/**
 * What comes back out of the settings table.
 *
 * The write side is guarded by `PUT /settings`, and there is a suite for it.
 * This is the READ side, which has no route in front of it and therefore no
 * second chance: `getSettings` rebuilds the object from rows every time it is
 * called, so whatever it is willing to hand back IS the setting, whoever put
 * the row there.
 *
 * And rows arrive from more places than the route. A build older than a setting
 * wrote what it knew; a build newer than this one wrote what it knows; a
 * developer with sqlite3 open wrote whatever they typed. The check here has to
 * stand on its own rather than assume the route already ran.
 *
 * The specific hole this file exists for: every store in the repo validated by
 * comparing `typeof value` against the default's type, which is exactly right
 * for a boolean and completely blind for an enum. A `soundTiming` row saying
 * 'whenever' passed, came back out, and then fell through every
 * `=== 'always'` comparison in the UI to behave as the other option — a
 * setting the user never chose, reached without anything reporting an error.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { DEFAULT_APP_SETTINGS } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dbPath: string;
let storage: SQLiteStorageProvider;

/** Writes a row the way something other than the route would. */
const writeRaw = (key: string, value: unknown): void => {
  // Through the storage's own patch, which does no validation of its own —
  // the same door a CLI, an older build or a hand-edit comes through.
  (storage as unknown as { database: { prepare(sql: string): { run(...a: unknown[]): void } } })
    .database
    .prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
};

beforeEach(async () => {
  dbPath = path.join(
    os.tmpdir(),
    `agenfk-settings-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  storage = new SQLiteStorageProvider();
  await storage.init({ path: dbPath });
});
afterEach(async () => {
  await storage.shutdown();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(dbPath + s)) fs.unlinkSync(dbPath + s);
  }
});

describe('reading settings back', () => {
  it('answers the documented defaults for a table nobody has written', () => {
    return expect(storage.getSettings()).resolves.toEqual(DEFAULT_APP_SETTINGS);
  });

  it('gives back what was stored', async () => {
    await storage.updateSettings({ soundTiming: 'always', attentionSound: false });
    const settings = await storage.getSettings();
    expect(settings.soundTiming).toBe('always');
    expect(settings.attentionSound).toBe(false);
  });

  it('refuses an enum value it does not recognise, and falls back to the default', async () => {
    // THE test. `typeof 'whenever' === typeof 'unfocused'`, so a check written
    // on the type alone hands this straight back to the UI.
    writeRaw('soundTiming', 'whenever');
    expect((await storage.getSettings()).soundTiming).toBe(DEFAULT_APP_SETTINGS.soundTiming);
  });

  it('does not let one bad row take the others with it', async () => {
    // A setting the user really did choose must survive a neighbour written by
    // a build that knew something this one does not.
    await storage.updateSettings({ attentionSound: false });
    writeRaw('soundTiming', 'whenever');
    const settings = await storage.getSettings();
    expect(settings.attentionSound).toBe(false);
    expect(settings.soundTiming).toBe(DEFAULT_APP_SETTINGS.soundTiming);
  });

  it('refuses a value of the wrong type, as it always has', async () => {
    writeRaw('attentionAlerts', 'true');
    expect((await storage.getSettings()).attentionAlerts)
      .toBe(DEFAULT_APP_SETTINGS.attentionAlerts);
  });

  it('ignores a key this build does not know', async () => {
    // A row written by a newer build belongs to that build, not to this one.
    writeRaw('somethingFromTheFuture', true);
    expect(await storage.getSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });
});
