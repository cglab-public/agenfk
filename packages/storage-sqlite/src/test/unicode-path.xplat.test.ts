/**
 * Issue #201 — the SQLite store must work when the DB path contains spaces and
 * non-ASCII characters, as in `C:\Users\Fábio Teixeira\.agenfk\db.sqlite`.
 * Runs on every OS (the Windows CI job includes *.xplat.test.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { SQLiteStorageProvider } from '../index';
import { ItemType, Status, type AgEnFKItem, type Project } from '@agenfk/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

let dir = '';
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('SQLiteStorageProvider with a unicode + space path', () => {
  it('creates the nested dir, persists accented text, and reopens it', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk Fábio Téixeira ção-'));
    const dbPath = path.join(dir, 'Área de Trabalho', '.agenfk', 'db.sqlite');

    const project: Project = {
      id: 'p-ü',
      name: 'Projeto Ação',
      description: 'descrição com acentuação',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } as Project;
    const item = {
      id: 'i-ü',
      projectId: project.id,
      type: ItemType.TASK,
      title: 'Configuração do pipeline — Windows',
      description: 'Verificação de caminhos com espaço e acentuação',
      status: Status.TODO,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } as AgEnFKItem;

    const first = new SQLiteStorageProvider();
    await first.init({ path: dbPath } as never);
    await first.createProject(project);
    await first.createItem(item);
    await first.shutdown();

    expect(fs.existsSync(dbPath)).toBe(true);

    const second = new SQLiteStorageProvider();
    await second.init({ path: dbPath } as never);
    const got = await second.getItem(item.id);
    await second.shutdown();

    expect(got?.title).toBe('Configuração do pipeline — Windows');
    expect(got?.description).toBe('Verificação de caminhos com espaço e acentuação');
  });
});
