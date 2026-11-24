/**
 * CGLAB-625: the project id is this machine's, so `agenfk init` keeps it out of
 * version control.
 *
 * `.agenfk/project.json` holds the repository's shared settings and is
 * committed. `.agenfk/local.json` holds `projectId`, a row id in ONE machine's
 * database, and is git-ignored: committed, it pointed a teammate's clone at a
 * project their database did not have, and made two clones on one machine one
 * project. Real directories and real git throughout: the ignore rule is only
 * proved by asking git.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

// A HOME of the test's own: init reads ~/.agenfk/config.json, and no --with-mcp
// install there means init never looks for Claude Code.
const { home } = vi.hoisted(() => ({ home: { dir: '' } }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  const homedir = vi.fn(() => home.dir || actual.homedir());
  return { ...actual, homedir, default: { ...actual, homedir } };
});
vi.mock('@agenfk/telemetry', () => ({
  TelemetryClient: vi.fn(function (this: any) { this.capture = vi.fn(); this.shutdown = vi.fn().mockResolvedValue(undefined); this.isEnabled = false; }),
  getInstallationId: vi.fn().mockReturnValue('test-install-id'),
  isTelemetryEnabled: vi.fn().mockReturnValue(false),
  getApiUrl: vi.fn().mockReturnValue('http://localhost:3000'),
  readServerPort: vi.fn().mockReturnValue(null),
  DEFAULT_API_PORT: 3000,
}));
vi.mock('axios');
vi.mock('inquirer', () => ({ default: { prompt: vi.fn() } }));

import axios from 'axios';
import { program } from '../index';

const mockedAxios = vi.mocked(axios, true);
let dir: string;
let out: string[];
let err: string[];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: 'pipe' }).toString().trim();
const agenfkFile = (name: string) => path.join(dir, '.agenfk', name);
const readJson = (p: string) => JSON.parse(fs.readFileSync(p, 'utf8'));
const isIgnored = (rel: string): boolean => {
  try { execFileSync('git', ['check-ignore', '-q', rel], { cwd: dir, stdio: 'pipe' }); return true; } catch { return false; }
};
const gitRepo = () => {
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 'T');
};
const declare = (o: unknown) => {
  fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
  fs.writeFileSync(agenfkFile('project.json'), JSON.stringify(o, null, 2));
};

function resetCommanderOptions(cmd: any) {
  ((cmd as any).options || []).forEach((opt: any) => cmd.setOptionValue(opt.attributeName(), undefined));
  (cmd.commands || []).forEach(resetCommanderOptions);
}

const run = (...args: string[]) => program.parseAsync(['node', 'agenfk', ...args]);

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-local-id-')));
  home.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-local-id-home-'));
  resetCommanderOptions(program);
  program.setOptionValue('toon', undefined);
  vi.spyOn(process, 'cwd').mockReturnValue(dir);
  out = []; err = [];
  // eslint-disable-next-line no-control-regex
  const strip = (a: any[]) => a.map(String).join(' ').replace(/\x1b\[[0-9;]*m/g, '');
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(strip(a)); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(strip(a)); });
  vi.spyOn(console, 'warn').mockImplementation((...a) => { err.push(strip(a)); });
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as any);
  mockedAxios.get.mockImplementation(async (url: string) => {
    if (url.endsWith('/projects/p-known')) return { data: { id: 'p-known', name: 'known' } } as any;
    if (/\/projects\/[^/]+$/.test(url)) throw Object.assign(new Error('Request failed with status code 404'), { response: { status: 404, data: { error: 'Project not found' } } });
    if (url.endsWith('/items')) return { data: [] } as any;
    return { data: { message: 'AgEnFK Framework API is running' } } as any;
  });
  mockedAxios.post.mockResolvedValue({ data: { id: 'p-new', name: 'demo' } } as any);
});
afterEach(() => {
  vi.restoreAllMocks();
  mockedAxios.get.mockReset();
  mockedAxios.post.mockReset();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(home.dir, { recursive: true, force: true });
  home.dir = '';
});

describe('agenfk init writes the id to the git-ignored local.json', () => {
  it('writes local.json, and no id into project.json', async () => {
    gitRepo();
    await run('init', 'demo');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-new' });
    expect(fs.existsSync(agenfkFile('project.json')), 'init wrote the shared file').toBe(false);
  });

  it('makes git ignore local.json, through the repository\'s .gitignore', async () => {
    gitRepo();
    await run('init', 'demo');
    expect(isIgnored('.agenfk/local.json')).toBe(true);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toMatch(/^\.agenfk\/local\.json$/m);
    // Only the machine file: the shared settings must stay committable.
    expect(isIgnored('.agenfk/project.json')).toBe(false);
    expect(out.join('\n')).toMatch(/\.gitignore/);
  });

  it('appends to an existing .gitignore on a line of its own', async () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');
    await run('init', 'demo');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\n.agenfk/local.json\n');
  });

  it('leaves .gitignore alone when git already ignores local.json', async () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), '.agenfk/\n');
    await run('init', 'demo');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('.agenfk/\n');
    expect(isIgnored('.agenfk/local.json')).toBe(true);
  });

  it('writes no .gitignore outside a git repository, and does not fail', async () => {
    await run('init', 'demo');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-new' });
    expect(fs.existsSync(path.join(dir, '.gitignore'))).toBe(false);
    expect(err, err.join('\n')).toEqual([]);
  });
});

describe('agenfk init on a fresh clone', () => {
  it('links an existing project with --project, keeping the shared settings as they are', async () => {
    gitRepo();
    declare({ verifyCommand: 'npm test' });
    const before = fs.readFileSync(agenfkFile('project.json'), 'utf8');
    await run('init', '--project', 'p-known');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    expect(fs.readFileSync(agenfkFile('project.json'), 'utf8')).toBe(before);
    expect(isIgnored('.agenfk/local.json')).toBe(true);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('refuses a --project the server does not know, and writes nothing', async () => {
    gitRepo();
    await run('init', '--project', 'p-missing').catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(err.join('\n')).toMatch(/Cannot link to project p-missing/);
    expect(fs.existsSync(agenfkFile('local.json'))).toBe(false);
  });

  it('creates a project for a clone that declares settings but has no id yet', async () => {
    gitRepo();
    declare({ verifyCommand: 'npm test' });
    await run('init', 'demo');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-new' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ verifyCommand: 'npm test' });
  });

  it('says how to link or create when given neither a name nor --project', async () => {
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/projects')) return { data: [] } as any;
      return { data: { message: 'AgEnFK Framework API is running' } } as any;
    });
    await run('init');
    expect(out.join('\n')).toMatch(/agenfk init --project <id>/);
    expect(out.join('\n')).not.toMatch(/create \.agenfk\/project\.json manually/i);
    expect(fs.existsSync(agenfkFile('local.json'))).toBe(false);
  });
});

describe('agenfk init on a repository from before the split', () => {
  it('moves the id into local.json and keeps the shared settings in project.json', async () => {
    gitRepo();
    declare({ projectId: 'p-known', verifyCommand: 'npm test' });
    await run('init');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ verifyCommand: 'npm test' });
    expect(isIgnored('.agenfk/local.json')).toBe(true);
    expect(out.join('\n')).toMatch(/moved/i);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('says a migration once: Moved, not also Removed', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    await run('init');
    const said = out.join('\n');
    expect(said.match(/Moved projectId p-known/g)).toHaveLength(1);
    expect(said).not.toMatch(/Removed projectId/);
  });

  it('says Moved when --project names the same id project.json carried', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    await run('init', '--project', 'p-known');
    expect(out.join('\n')).toMatch(/Moved projectId p-known/);
    expect(out.join('\n')).not.toMatch(/Removed projectId/);
  });

  it('still says Removed when --project drops a different id', async () => {
    gitRepo();
    declare({ projectId: 'p-elsewhere', flow: 'TDD Flow' });
    await run('init', '--project', 'p-known');
    expect(out.join('\n')).toMatch(/Removed projectId p-elsewhere/);
  });

  it('keeps an emptied project.json, so every other clone keeps its project marker (review #4)', async () => {
    gitRepo();
    declare({ projectId: 'p-known' });
    await run('init');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    expect(readJson(agenfkFile('project.json'))).toEqual({});
  });

  it('asks for a commit only when project.json is tracked (review #8)', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    git(dir, 'add', '.agenfk/project.json');
    git(dir, 'commit', '-qm', 'tracked');
    await run('init');
    expect(out.join('\n')).toMatch(/commit .agenfk\/project\.json/i);
  });

  it('asks for no commit when project.json is not tracked', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    await run('init');
    expect(out.join('\n')).not.toMatch(/commit .agenfk\/project\.json/i);
  });

  it('does not move an id this server does not have - another machine\'s - and says how to link (review #1)', async () => {
    gitRepo();
    declare({ projectId: 'p-elsewhere', flow: 'TDD Flow' });
    const before = fs.readFileSync(agenfkFile('project.json'), 'utf8');
    await run('init');
    expect(fs.existsSync(agenfkFile('local.json'))).toBe(false);
    expect(fs.readFileSync(agenfkFile('project.json'), 'utf8')).toBe(before);
    expect(out.join('\n') + err.join('\n')).toMatch(/p-elsewhere/);
    expect(out.join('\n') + err.join('\n')).toMatch(/agenfk init --project <id>/);
  });

  it('links --project on a repository whose project.json carries someone else\'s id (review #1)', async () => {
    gitRepo();
    declare({ projectId: 'p-elsewhere', flow: 'TDD Flow' });
    await run('init', '--project', 'p-known');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ flow: 'TDD Flow' });
  });

  it('migrates instead of creating when init <name> meets a legacy id this server has (re-review A)', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    await run('init', 'demo');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ flow: 'TDD Flow' });
    expect(mockedAxios.post).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/demo.*not created|already/i);
  });

  it('reports a server error as one, not as a foreign id (re-review C)', async () => {
    gitRepo();
    declare({ projectId: 'p-known', flow: 'TDD Flow' });
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/projects/p-known')) throw Object.assign(new Error('boom'), { response: { status: 500, data: { error: 'database is locked' } } });
      return { data: { message: 'AgEnFK Framework API is running' } } as any;
    });
    await run('init').catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    const said = out.join('\n') + err.join('\n');
    expect(said).toMatch(/database is locked/);
    expect(said).not.toMatch(/another machine/);
    expect(fs.existsSync(agenfkFile('local.json'))).toBe(false);
  });

  it('creates a project for init <name> on such a repository, dropping the foreign id', async () => {
    gitRepo();
    declare({ projectId: 'p-elsewhere', flow: 'TDD Flow' });
    await run('init', 'demo');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-new' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ flow: 'TDD Flow' });
  });

  it('leaves a project.json with a non-string projectId untouched (review #7)', async () => {
    gitRepo();
    declare({ projectId: 7, flow: 'TDD Flow' });
    const before = fs.readFileSync(agenfkFile('project.json'), 'utf8');
    mockedAxios.get.mockImplementation(async (url: string) => {
      if (url.endsWith('/projects')) return { data: [] } as any;
      return { data: { message: 'AgEnFK Framework API is running' } } as any;
    });
    await run('init');
    expect(fs.readFileSync(agenfkFile('project.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(agenfkFile('local.json'))).toBe(false);
  });

  it('drops a stale id from project.json when local.json already names the project', async () => {
    gitRepo();
    declare({ projectId: 'p-elsewhere', flow: 'TDD Flow' });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    await run('init');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-here' });
    expect(readJson(agenfkFile('project.json'))).toEqual({ flow: 'TDD Flow' });
  });
});

describe('agenfk init on an initialized project', () => {
  it('says it is already initialized, and repairs a missing ignore rule', async () => {
    gitRepo();
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    await run('init', 'other');
    expect(out.join('\n')).toMatch(/already initialized.*p-here/i);
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-here' });
    expect(isIgnored('.agenfk/local.json')).toBe(true);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });
});

describe('agenfk init --project on a linked directory', () => {
  it('relinks it to the project given (review #1)', async () => {
    gitRepo();
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    await run('init', '--project', 'p-known');
    expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
  });

  it('warns when the project already lives in another directory on this machine (review #3)', async () => {
    gitRepo();
    const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-local-id-other-')));
    try {
      mockedAxios.get.mockImplementation(async (url: string) => {
        if (url.endsWith('/projects/p-known')) return { data: { id: 'p-known', name: 'known', projectRoot: other } } as any;
        return { data: { message: 'AgEnFK Framework API is running' } } as any;
      });
      await run('init', '--project', 'p-known');
      const said = out.join('\n') + err.join('\n');
      expect(said).toContain(other);
      expect(said).toMatch(/worktree/i);
      expect(readJson(agenfkFile('local.json'))).toEqual({ projectId: 'p-known' });
    } finally { fs.rmSync(other, { recursive: true, force: true }); }
  });
});

describe('agenfk init in odd places', () => {
  const worktreeOfLinked = () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'one');
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-known' }));
    const wt = path.join(fs.realpathSync(home.dir), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'card', wt);
    vi.mocked(process.cwd).mockReturnValue(wt);
    return wt;
  };

  it.each([[[]], [['demo']], [['--project', 'p-known']]])('refuses to run in a linked worktree, naming the main checkout (re-review B): init %j', async (args) => {
    const wt = worktreeOfLinked();
    await run('init', ...(args as string[])).catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(err.join('\n')).toContain(dir);
    expect(err.join('\n')).toMatch(/worktree/);
    expect(fs.existsSync(path.join(wt, '.agenfk'))).toBe(false);
    expect(fs.existsSync(path.join(wt, '.gitignore'))).toBe(false);
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('names the matching subproject in the main checkout, not just its top (third pass)', async () => {
    const wt = worktreeOfLinked();
    const sub = path.join(wt, 'packages', 'foo');
    fs.mkdirSync(sub, { recursive: true });
    vi.mocked(process.cwd).mockReturnValue(sub);
    await run('init', 'demo').catch(() => {});
    expect(err.join('\n')).toContain(`cd ${path.join(dir, 'packages', 'foo')} && agenfk init demo`);
  });

  it('configure-ide refuses a linked worktree too (re-review D)', async () => {
    const wt = worktreeOfLinked();
    await run('configure-ide').catch(() => {});
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(err.join('\n')).toMatch(/worktree/);
    expect(fs.existsSync(path.join(wt, '.claude'))).toBe(false);
  });

  it('warns that it is creating a project nested inside another (review #9)', async () => {
    gitRepo();
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-outer' }));
    const sub = path.join(dir, 'services', 'api');
    fs.mkdirSync(sub, { recursive: true });
    vi.mocked(process.cwd).mockReturnValue(sub);
    await run('init', 'demo');
    expect(out.join('\n') + err.join('\n')).toMatch(new RegExp(`inside.*${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(readJson(path.join(sub, '.agenfk', 'local.json'))).toEqual({ projectId: 'p-new' });
  });

  it('keeps a CRLF .gitignore CRLF (review #12)', async () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules\r\n');
    await run('init', 'demo');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('node_modules\r\n.agenfk/local.json\r\n');
  });
});

describe('commands that resolve the current project', () => {
  it('current-project prints the id from local.json', async () => {
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    declare({ verifyCommand: 'npm test' });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    await run('current-project');
    expect(out).toEqual(['p-here']);
  });

  it('current-project still reads a legacy id, and warns how to move it', async () => {
    declare({ projectId: 'p-old' });
    await run('current-project');
    expect(out).toEqual(['p-old']);
    expect(err.join('\n')).toMatch(/local\.json/);
    expect(err.join('\n')).toMatch(/agenfk init/);
  });

  it('current-project tells a clone with no id how to link it', async () => {
    declare({ verifyCommand: 'npm test' });
    await expect(run('current-project')).rejects.toThrow(/exit 1/);
    expect(err.join('\n')).toMatch(/agenfk init --project <id>/);
  });

  it('current-project in a worktree answers with the main checkout\'s id (review #2)', async () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'one');
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-main' }));
    const wt = path.join(fs.realpathSync(home.dir), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'card', wt);
    vi.mocked(process.cwd).mockReturnValue(wt);
    await run('current-project');
    expect(out).toEqual(['p-main']);
  });

  it('current-project in a worktree of an unlinked checkout points at the main checkout, never init here', async () => {
    gitRepo();
    fs.writeFileSync(path.join(dir, 'f'), 'x');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'one');
    const wt = path.join(fs.realpathSync(home.dir), 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'card', wt);
    vi.mocked(process.cwd).mockReturnValue(wt);
    await expect(run('current-project')).rejects.toThrow(/exit 1/);
    expect(err.join('\n')).toMatch(/git worktree of/);
    expect(err.join('\n')).toContain(`cd ${dir} && agenfk init --project <id>`);
  });

  it('list scopes to the project local.json names', async () => {
    fs.mkdirSync(path.join(dir, '.agenfk'), { recursive: true });
    fs.writeFileSync(agenfkFile('local.json'), JSON.stringify({ projectId: 'p-here' }));
    await run('list', '--json');
    const call = mockedAxios.get.mock.calls.find(c => String(c[0]).endsWith('/items'));
    expect((call?.[1] as any)?.params?.projectId).toBe('p-here');
  });
});
