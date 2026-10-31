/**
 * CGLAB-696 story review 2 (DEL-3): a release must not be published without its Airlock base image.
 *
 * Every `agenfk airlock` launch pulls ghcr.io/<owner>/agenfk-airlock-base:<its own version>. The
 * image was built only by airlock-image.yml on a v* tag push - and release.yml pushes its tag with
 * GITHUB_TOKEN when no RELEASE_TOKEN is set, which starts no other workflow: the release shipped and
 * every launch of that version failed. These specs pin release.yml to build the image itself, from
 * the commit it releases, before anything is published, and the tag-push run not to build it twice.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { load } from 'js-yaml';

const ROOT = path.resolve(__dirname, '../../../..');
const RELEASE = path.join(ROOT, '.github/workflows/release.yml');
const IMAGE = path.join(ROOT, '.github/workflows/airlock-image.yml');

type Step = { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> };
type Job = { needs?: string | string[]; uses?: string; with?: Record<string, string>; outputs?: Record<string, string>; steps?: Step[]; permissions?: Record<string, string>; if?: string };
type Workflow = { on: Record<string, any>; jobs: Record<string, Job> };
const read = (f: string) => load(fs.readFileSync(f, 'utf8')) as Workflow;
const needsOf = (j: Job) => (Array.isArray(j.needs) ? j.needs : j.needs ? [j.needs] : []);
/** The job whose steps run `pattern`. */
const jobRunning = (w: Workflow, pattern: RegExp) => Object.entries(w.jobs).find(([, j]) => (j.steps ?? []).some((s) => pattern.test(s.run ?? '')));

describe('release.yml builds the Airlock image before it publishes', () => {
  it('publishes (tag and GitHub release) only after the image job built this version from the released commit', () => {
    const w = read(RELEASE);
    const publish = jobRunning(w, /gh release create/);
    expect(publish).toBeDefined();
    const [publishName, publishJob] = publish!;
    // The tag goes out with the release, after the image: nowhere before.
    expect(jobRunning(w, /git tag "v\$\{VERSION\}"|git push origin "v/)?.[0]).toBe(publishName);
    const image = Object.entries(w.jobs).find(([, j]) => j.uses === './.github/workflows/airlock-image.yml');
    expect(image).toBeDefined();
    const [imageName, imageJob] = image!;
    expect(needsOf(publishJob)).toContain(imageName);
    // Built from what is released: the bumped commit and its version, from the job that made them.
    const prepare = jobRunning(w, /git push$|git push\n/m) ?? jobRunning(w, /bump-version\.mjs/);
    const [prepareName, prepareJob] = prepare!;
    expect(needsOf(imageJob)).toContain(prepareName);
    expect(imageJob.with?.version).toBe(`\${{ needs.${prepareName}.outputs.version }}`);
    expect(imageJob.with?.ref).toBe(`\${{ needs.${prepareName}.outputs.sha }}`);
    expect(Object.keys(prepareJob.outputs ?? {})).toEqual(expect.arrayContaining(['version', 'sha']));
    // The image is pushed to GHCR by the called workflow: the call grants it.
    expect(imageJob.permissions?.packages).toBe('write');
  });

  it('airlock-image.yml can be called with a version and the commit to build', () => {
    const w = read(IMAGE);
    expect(Object.keys(w.on.workflow_call?.inputs ?? {})).toEqual(expect.arrayContaining(['version', 'ref']));
    const checkout = (w.jobs.build.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/checkout'));
    // The commit given, else the one the run started at: never the branch, which can move meanwhile.
    expect(checkout?.with?.ref).toBe('${{ inputs.ref || github.sha }}');
    // Still built on a tag push (a release cut by hand pushes its tag itself).
    expect(w.on.push?.tags).toEqual(['v[0-9]*']);
  });
});

describe('a tag-push run builds no image already published', () => {
  const w = read(IMAGE);
  const steps = w.jobs.build.steps ?? [];
  const check = steps.find((s) => s.id === 'published');
  const SHA = 'a'.repeat(40);
  const imageOf = (platforms: Record<string, string>) => JSON.stringify(Object.fromEntries(Object.entries(platforms).map(([p, rev]) => [p, { config: { Labels: { 'org.opencontainers.image.revision': rev } } }])));

  /** Runs the check's script with a docker stand-in answering `buildx imagetools inspect` with `image` (null: not published). */
  const runCheck = (image: string | null, event = 'push') => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenfk-image-check-'));
    fs.writeFileSync(path.join(dir, 'image.json'), image ?? '');
    fs.writeFileSync(path.join(dir, 'docker'), `#!/bin/sh\n[ "$1 $2 $3" = "buildx imagetools inspect" ] || exit 2\n[ -s "${path.join(dir, 'image.json')}" ] || exit 1\ncat "${path.join(dir, 'image.json')}"\n`, { mode: 0o755 });
    const out = path.join(dir, 'out');
    fs.writeFileSync(out, '');
    const values: Record<string, string> = { EVENT: event, IMAGE: 'ghcr.io/acme/agenfk-airlock-base:2.1.0', SHA };
    const env: Record<string, string> = { PATH: `${dir}:/usr/bin:/bin:/opt/homebrew/bin`, GITHUB_OUTPUT: out };
    for (const k of Object.keys(check?.env ?? {})) env[k] = values[k] ?? '';
    const r = spawnSync('bash', ['-c', check?.run ?? 'exit 9'], { env, encoding: 'utf8' });
    const outputs = fs.readFileSync(out, 'utf8');
    fs.rmSync(dir, { recursive: true, force: true });
    return { status: r.status, outputs };
  };

  it('skips the build only when both platforms are published from this very commit', () => {
    expect(check).toBeDefined();
    expect(runCheck(imageOf({ 'linux/amd64': SHA, 'linux/arm64': SHA }))).toEqual({ status: 0, outputs: 'skip=true\n' });
    // Not published; another commit's image under the same version; one platform only.
    expect(runCheck(null)).toEqual({ status: 0, outputs: 'skip=false\n' });
    expect(runCheck(imageOf({ 'linux/amd64': 'b'.repeat(40), 'linux/arm64': 'b'.repeat(40) }))).toEqual({ status: 0, outputs: 'skip=false\n' });
    expect(runCheck(imageOf({ 'linux/amd64': SHA }))).toEqual({ status: 0, outputs: 'skip=false\n' });
    // Called by release.yml (its event is the caller's) or dispatched by hand: always built.
    expect(runCheck(imageOf({ 'linux/amd64': SHA, 'linux/arm64': SHA }), 'workflow_dispatch')).toEqual({ status: 0, outputs: 'skip=false\n' });
    const build = steps.find((s) => (s.uses ?? '').startsWith('docker/build-push-action'));
    expect(build?.if).toContain("steps.published.outputs.skip != 'true'");
  });

  it('pushes the image it builds, for both platforms, labelled with the commit it was built from', () => {
    const build = steps.find((s) => (s.uses ?? '').startsWith('docker/build-push-action'));
    expect(build?.with?.push).toBe(true);
    expect(build?.with?.platforms).toBe('linux/amd64,linux/arm64');
    expect(String(build?.with?.labels)).toBe('org.opencontainers.image.revision=${{ steps.sha.outputs.sha }}');
    expect(steps.find((s) => s.id === 'sha')?.run).toContain('git rev-parse HEAD');
    expect(check?.env?.SHA).toBe('${{ steps.sha.outputs.sha }}');
  });
});

describe('release.yml hands the released commit and its distributable from job to job', () => {
  it('the commit: prepare\'s sha output is the pushed bump, and publish checks it out', () => {
    const w = read(RELEASE);
    expect(w.jobs.prepare.outputs?.sha).toBe('${{ steps.sha.outputs.sha }}');
    const steps = w.jobs.prepare.steps ?? [];
    const push = steps.findIndex((s) => /^\s*git push\s*$/m.test(s.run ?? ''));
    const sha = steps.findIndex((s) => s.id === 'sha');
    expect(push).toBeGreaterThanOrEqual(0);
    expect(sha).toBeGreaterThan(push);
    expect(steps[sha].run).toContain('git rev-parse HEAD');
    const checkout = (w.jobs.publish.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/checkout'));
    expect(checkout?.with?.ref).toBe('${{ needs.prepare.outputs.sha }}');
  });

  it('the distributable: uploaded by prepare under the name publish downloads, and released', () => {
    const w = read(RELEASE);
    const up = (w.jobs.prepare.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/upload-artifact'));
    const down = (w.jobs.publish.steps ?? []).find((s) => (s.uses ?? '').startsWith('actions/download-artifact'));
    expect(up?.with?.path).toBe('agenfk-dist.tar.gz');
    expect(down?.with?.name).toBe(up?.with?.name);
    expect((w.jobs.publish.steps ?? []).some((s) => /gh release create "v\$\{VERSION\}" agenfk-dist\.tar\.gz/.test(s.run ?? ''))).toBe(true);
  });
});

describe.skipIf(spawnSync('actionlint', ['-version']).status !== 0)('the workflows, by actionlint', () => {
  it('release.yml and airlock-image.yml are valid', () => {
    const r = spawnSync('actionlint', [RELEASE, IMAGE], { encoding: 'utf8', cwd: ROOT });
    expect(r.stdout + r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
