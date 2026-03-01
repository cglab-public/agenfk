/**
 * GitHub Issues Sync Module
 *
 * Bidirectional sync between AgenFK items and GitHub Issues.
 * Uses the `gh` CLI for all GitHub operations (no OAuth/Octokit needed).
 */

import { execSync } from 'child_process';
import { Status, ItemType, AgenFKItem, GitHubRepoMapping } from '@agenfk/core';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Status & Type Mappings ──────────────────────────────────────────────────

/** GitHub label names for AgenFK statuses */
const STATUS_LABEL_MAP: Record<string, string> = {
  [Status.IDEAS]:       'status:ideas',
  [Status.TODO]:        'status:todo',
  [Status.IN_PROGRESS]: 'status:in-progress',
  [Status.REVIEW]:      'status:review',
  [Status.TEST]:        'status:test',
  [Status.DONE]:        'status:done',
  [Status.BLOCKED]:     'status:blocked',
  [Status.PAUSED]:      'status:paused',
  [Status.ARCHIVED]:    'status:archived',
  [Status.TRASHED]:     'status:trashed',
};

/** Reverse map: GitHub label → AgenFK status */
const LABEL_STATUS_MAP: Record<string, Status> = Object.fromEntries(
  Object.entries(STATUS_LABEL_MAP).map(([k, v]) => [v, k as Status])
);

/** GitHub label names for AgenFK item types */
const TYPE_LABEL_MAP: Record<string, string> = {
  [ItemType.EPIC]:  'type:epic',
  [ItemType.STORY]: 'type:story',
  [ItemType.TASK]:  'type:task',
  [ItemType.BUG]:   'type:bug',
};

/** Reverse map: GitHub label → AgenFK item type */
const LABEL_TYPE_MAP: Record<string, ItemType> = Object.fromEntries(
  Object.entries(TYPE_LABEL_MAP).map(([k, v]) => [v, k as ItemType])
);

/** Label color palette */
const STATUS_LABEL_COLORS: Record<string, string> = {
  'status:ideas':       'C5DEF5',
  'status:todo':        'D4C5F9',
  'status:in-progress': 'FEF2C0',
  'status:review':      'BFD4F2',
  'status:test':        'FBCA04',
  'status:done':        '0E8A16',
  'status:blocked':     'E11D48',
  'status:paused':      'F9D0C4',
  'status:archived':    'EDEDED',
  'status:trashed':     'B60205',
};

const TYPE_LABEL_COLORS: Record<string, string> = {
  'type:epic':  '7057FF',
  'type:story': '008672',
  'type:task':  '0075CA',
  'type:bug':   'D73A4A',
};

/** All labels that need to exist on the repo */
export const ALL_LABELS = [
  ...Object.values(STATUS_LABEL_MAP),
  ...Object.values(TYPE_LABEL_MAP),
];

/** Statuses that map to a closed GitHub issue */
const CLOSED_STATUSES = new Set([Status.DONE, Status.ARCHIVED, Status.TRASHED]);

// ── Public Mapping Functions ────────────────────────────────────────────────

export function statusToLabel(status: Status): string {
  return STATUS_LABEL_MAP[status] || 'status:todo';
}

export function labelToStatus(label: string): Status | null {
  return LABEL_STATUS_MAP[label] || null;
}

export function typeToLabel(type: ItemType): string {
  return TYPE_LABEL_MAP[type] || 'type:task';
}

export function labelToType(label: string): ItemType | null {
  return LABEL_TYPE_MAP[label] || null;
}

export function statusToIssueState(status: Status): 'open' | 'closed' {
  return CLOSED_STATUSES.has(status) ? 'closed' : 'open';
}

/** Extract AgenFK status and type from a set of GitHub labels */
export function labelsToMeta(labels: string[]): { status: Status | null; type: ItemType | null } {
  let status: Status | null = null;
  let type: ItemType | null = null;
  for (const label of labels) {
    if (!status) status = labelToStatus(label);
    if (!type) type = labelToType(label);
  }
  return { status, type };
}

/** Build the full label set for an item (one status + one type) */
export function itemToLabels(item: AgenFKItem): string[] {
  return [statusToLabel(item.status), typeToLabel(item.type)];
}

// ── gh CLI Wrapper ──────────────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: 'OPEN' | 'CLOSED';
  labels: { name: string }[];
  url: string;
  updatedAt: string;
  comments: GitHubComment[];
}

export interface GitHubComment {
  id: string;
  body: string;
  author: { login: string };
  createdAt: string;
}

export interface SyncResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function repoFlag(mapping: GitHubRepoMapping): string {
  return `-R ${mapping.owner}/${mapping.repo}`;
}

/** Verify gh CLI is available and authenticated */
export function verifyGhCli(): boolean {
  try {
    execSync('gh auth status', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Create a GitHub Issue. Returns the created issue with number and URL. */
export function createIssue(
  mapping: GitHubRepoMapping,
  title: string,
  body: string,
  labels: string[]
): { number: number; url: string } {
  const labelFlag = labels.map(l => `-l "${l}"`).join(' ');
  const escapedTitle = title.replace(/"/g, '\\"');
  // gh issue create outputs the issue URL on stdout (no --json support)
  const url = execSync(
    `gh issue create ${repoFlag(mapping)} --title "${escapedTitle}" --body-file - ${labelFlag}`,
    { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();
  // Extract issue number from URL: https://github.com/owner/repo/issues/123
  const match = url.match(/\/issues\/(\d+)$/);
  const number = match ? parseInt(match[1], 10) : 0;
  return { number, url };
}

/** Update an existing GitHub Issue */
export function updateIssue(
  mapping: GitHubRepoMapping,
  issueNumber: number,
  updates: { title?: string; body?: string; labels?: string[]; state?: 'open' | 'closed' }
): void {
  const args: string[] = [repoFlag(mapping)];

  if (updates.title) {
    args.push(`--title "${updates.title.replace(/"/g, '\\"')}"`);
  }
  if (updates.labels) {
    // Remove all agenfk labels first, then add new ones
    const removeLabels = ALL_LABELS.join(',');
    try {
      execSync(
        `gh issue edit ${issueNumber} ${repoFlag(mapping)} --remove-label "${removeLabels}"`,
        { stdio: 'pipe' }
      );
    } catch { /* labels may not exist yet */ }
    const addLabels = updates.labels.join(',');
    args.push(`--add-label "${addLabels}"`);
  }

  if (updates.body !== undefined) {
    execSync(
      `gh issue edit ${issueNumber} ${args.join(' ')} --body-file -`,
      { input: updates.body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } else if (args.length > 1) {
    execSync(`gh issue edit ${issueNumber} ${args.join(' ')}`, { stdio: 'pipe' });
  }

  // Handle state change separately
  if (updates.state) {
    const stateCmd = updates.state === 'closed' ? 'close' : 'reopen';
    try {
      execSync(`gh issue ${stateCmd} ${issueNumber} ${repoFlag(mapping)}`, { stdio: 'pipe' });
    } catch { /* already in desired state */ }
  }
}

/** Get a single GitHub Issue with comments */
export function getIssue(mapping: GitHubRepoMapping, issueNumber: number): GitHubIssue {
  const result = execSync(
    `gh issue view ${issueNumber} ${repoFlag(mapping)} --json number,title,body,state,labels,url,updatedAt,comments`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return JSON.parse(result);
}

/** List GitHub Issues (with pagination) */
export function listIssues(
  mapping: GitHubRepoMapping,
  opts: { state?: 'open' | 'closed' | 'all'; limit?: number; labels?: string[] } = {}
): GitHubIssue[] {
  const args: string[] = [repoFlag(mapping)];
  args.push(`--state ${opts.state || 'all'}`);
  args.push(`--limit ${opts.limit || 200}`);
  if (opts.labels?.length) {
    args.push(opts.labels.map(l => `-l "${l}"`).join(' '));
  }
  args.push('--json number,title,body,state,labels,url,updatedAt');

  const result = execSync(`gh issue list ${args.join(' ')}`, {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return JSON.parse(result);
}

/** Add a comment to a GitHub Issue */
export function addIssueComment(
  mapping: GitHubRepoMapping,
  issueNumber: number,
  body: string
): void {
  execSync(
    `gh issue comment ${issueNumber} ${repoFlag(mapping)} --body-file -`,
    { input: body, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

/** List comments on a GitHub Issue */
export function listIssueComments(
  mapping: GitHubRepoMapping,
  issueNumber: number
): GitHubComment[] {
  const result = execSync(
    `gh issue view ${issueNumber} ${repoFlag(mapping)} --json comments`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  );
  return JSON.parse(result).comments || [];
}

// ── Label Management ────────────────────────────────────────────────────────

/** Ensure all required labels exist on the repo (idempotent) */
export function ensureLabels(mapping: GitHubRepoMapping): { created: string[]; existing: string[] } {
  const created: string[] = [];
  const existing: string[] = [];

  // Fetch existing labels
  let existingLabels: Set<string>;
  try {
    const result = execSync(
      `gh label list ${repoFlag(mapping)} --json name --limit 200`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    existingLabels = new Set(JSON.parse(result).map((l: { name: string }) => l.name));
  } catch {
    existingLabels = new Set();
  }

  const allColorMap = { ...STATUS_LABEL_COLORS, ...TYPE_LABEL_COLORS };

  for (const label of ALL_LABELS) {
    if (existingLabels.has(label)) {
      existing.push(label);
      continue;
    }

    const color = allColorMap[label] || 'EDEDED';
    const description = label.startsWith('status:')
      ? `AgenFK status: ${label.replace('status:', '')}`
      : `AgenFK type: ${label.replace('type:', '')}`;

    try {
      execSync(
        `gh label create "${label}" ${repoFlag(mapping)} --color "${color}" --description "${description}"`,
        { stdio: 'pipe' }
      );
      created.push(label);
    } catch {
      // Label may have been created by another process
      existing.push(label);
    }
  }

  return { created, existing };
}

// ── Config Helpers ──────────────────────────────────────────────────────────

/** Load GitHub config for a project from ~/.agenfk/config.json */
export function loadGitHubConfig(projectId: string): GitHubRepoMapping | null {
  try {
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    if (!fs.existsSync(configPath)) return null;
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cfg.github?.repos?.[projectId] || null;
  } catch {
    return null;
  }
}

/** Update lastSyncedAt in config */
export function updateLastSynced(projectId: string): void {
  try {
    const configPath = path.join(os.homedir(), '.agenfk', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.github?.repos?.[projectId]) {
      cfg.github.repos[projectId].lastSyncedAt = new Date().toISOString();
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    }
  } catch { /* best effort */ }
}

// ── Sync Comment Marker ─────────────────────────────────────────────────────

const SYNC_MARKER = '<!-- agenfk-sync -->';

/** Prefix a comment body with the sync marker */
export function markSyncedComment(body: string, author?: string): string {
  const prefix = author ? `**[AgenFK — ${author}]**` : '**[AgenFK]**';
  return `${SYNC_MARKER}\n${prefix}\n\n${body}`;
}

/** Check if a comment was synced from AgenFK */
export function isSyncedComment(body: string): boolean {
  return body.startsWith(SYNC_MARKER);
}

// ── Outbound Sync (AgenFK → GitHub) ────────────────────────────────────────

export interface PushItemResult {
  action: 'created' | 'updated' | 'skipped';
  issueNumber?: number;
  issueUrl?: string;
  error?: string;
}

/** Build the issue body from an AgenFK item, optionally including child task list */
export function buildIssueBody(
  item: AgenFKItem,
  children?: AgenFKItem[]
): string {
  const parts: string[] = [];

  // AgenFK metadata header
  parts.push(`<!-- agenfk-id:${item.id} -->`);
  parts.push('');

  if (item.description) {
    parts.push(item.description);
    parts.push('');
  }

  // Parent-child task list
  if (children && children.length > 0) {
    parts.push('## Sub-items');
    parts.push('');
    for (const child of children) {
      const done = CLOSED_STATUSES.has(child.status);
      const checkbox = done ? '[x]' : '[ ]';
      const issueRef = child.externalId ? ` (#${child.externalId})` : '';
      parts.push(`- ${checkbox} ${child.title}${issueRef}`);
    }
    parts.push('');
  }

  // Footer with link back
  parts.push('---');
  parts.push(`*Synced from [AgenFK](https://github.com/anthropics/agenfk) · ID: \`${item.id}\`*`);

  return parts.join('\n');
}

/**
 * Push a single AgenFK item to GitHub Issues.
 * Creates a new issue if no externalId, updates existing otherwise.
 * Returns the updated item fields (externalId, externalUrl) to be persisted by the caller.
 */
export function pushItem(
  mapping: GitHubRepoMapping,
  item: AgenFKItem,
  children?: AgenFKItem[]
): PushItemResult {
  const labels = itemToLabels(item);
  const body = buildIssueBody(item, children);
  const state = statusToIssueState(item.status);

  try {
    if (!item.externalId) {
      // Create new issue
      const issue = createIssue(mapping, item.title, body, labels);
      return {
        action: 'created',
        issueNumber: issue.number,
        issueUrl: issue.url,
      };
    } else {
      // Update existing issue
      const issueNumber = parseInt(item.externalId, 10);
      updateIssue(mapping, issueNumber, {
        title: item.title,
        body,
        labels,
        state,
      });
      return {
        action: 'updated',
        issueNumber,
        issueUrl: item.externalUrl || undefined,
      };
    }
  } catch (err: any) {
    return {
      action: 'skipped',
      error: err.message || String(err),
    };
  }
}

/** Push AgenFK comments to a GitHub Issue (skips already-synced ones) */
export function pushComments(
  mapping: GitHubRepoMapping,
  item: AgenFKItem
): number {
  if (!item.externalId || !item.comments?.length) return 0;

  const issueNumber = parseInt(item.externalId, 10);

  // Get existing GitHub comments to check for already-synced ones
  let existingComments: GitHubComment[];
  try {
    existingComments = listIssueComments(mapping, issueNumber);
  } catch {
    return 0;
  }

  const syncedBodies = new Set(
    existingComments.filter(c => isSyncedComment(c.body)).map(c => c.body)
  );

  let pushed = 0;
  for (const comment of item.comments) {
    const markedBody = markSyncedComment(comment.content, comment.author);
    if (syncedBodies.has(markedBody)) continue;

    try {
      addIssueComment(mapping, issueNumber, markedBody);
      pushed++;
    } catch {
      // Best effort — skip failed comments
    }
  }

  return pushed;
}

/**
 * Push all items for a project to GitHub.
 * The caller provides the items and a callback to persist externalId/externalUrl.
 */
export function pushAll(
  mapping: GitHubRepoMapping,
  items: AgenFKItem[],
  getChildren: (parentId: string) => AgenFKItem[]
): SyncResult {
  const result: SyncResult = { created: 0, updated: 0, skipped: 0, failed: 0, errors: [] };

  // Push parent items first (EPICs/STORYs), then children
  const parents = items.filter(i => !i.parentId);
  const children = items.filter(i => !!i.parentId);
  const ordered = [...parents, ...children];

  for (const item of ordered) {
    // Skip TRASHED items
    if (item.status === Status.TRASHED) {
      result.skipped++;
      continue;
    }

    const itemChildren = getChildren(item.id);
    const pushResult = pushItem(mapping, item, itemChildren.length > 0 ? itemChildren : undefined);

    switch (pushResult.action) {
      case 'created':
        result.created++;
        break;
      case 'updated':
        result.updated++;
        break;
      case 'skipped':
        if (pushResult.error) {
          result.failed++;
          result.errors.push(`${item.title}: ${pushResult.error}`);
        } else {
          result.skipped++;
        }
        break;
    }
  }

  return result;
}

// ── Inbound Sync (GitHub → AgenFK) ─────────────────────────────────────────

export interface PullItemResult {
  action: 'created' | 'updated' | 'skipped' | 'conflict';
  itemId?: string;
  issueNumber: number;
  reason?: string;
}

/** Extract the AgenFK item ID from an issue body, if present */
export function extractItemId(body: string): string | null {
  const match = body.match(/<!-- agenfk-id:([a-f0-9-]+) -->/);
  return match ? match[1] : null;
}

/**
 * Pull a single GitHub Issue into an AgenFK item.
 * Returns data for the caller to create/update in storage.
 */
export function pullItem(
  issue: GitHubIssue,
  existingItem: AgenFKItem | null,
  projectId: string
): PullItemResult & { itemData?: Partial<AgenFKItem> } {
  const labelNames = issue.labels.map(l => l.name);
  const meta = labelsToMeta(labelNames);

  // Determine status from labels, falling back to open/closed state
  let status = meta.status;
  if (!status) {
    status = issue.state === 'CLOSED' ? Status.DONE : Status.TODO;
  }

  const type = meta.type || ItemType.TASK;

  if (existingItem) {
    // Conflict detection: if local is newer, skip
    const localUpdated = new Date(existingItem.updatedAt).getTime();
    const remoteUpdated = new Date(issue.updatedAt).getTime();

    if (localUpdated > remoteUpdated) {
      return {
        action: 'conflict',
        issueNumber: issue.number,
        reason: 'Local item is newer than GitHub issue',
      };
    }

    return {
      action: 'updated',
      itemId: existingItem.id,
      issueNumber: issue.number,
      itemData: {
        title: issue.title,
        description: stripSyncFooter(issue.body || ''),
        status,
        externalId: String(issue.number),
        externalUrl: issue.url,
      },
    };
  }

  // New item from GitHub
  return {
    action: 'created',
    issueNumber: issue.number,
    itemData: {
      projectId,
      type,
      title: issue.title,
      description: stripSyncFooter(issue.body || ''),
      status,
      externalId: String(issue.number),
      externalUrl: issue.url,
    } as Partial<AgenFKItem>,
  };
}

/** Strip the AgenFK sync footer and metadata from issue body */
function stripSyncFooter(body: string): string {
  return body
    .replace(/<!-- agenfk-id:[a-f0-9-]+ -->\n*/g, '')
    .replace(/\n---\n\*Synced from \[AgenFK\].*\*/g, '')
    .trim();
}

/** Pull comments from a GitHub Issue that weren't synced from AgenFK */
export function pullComments(
  issue: GitHubIssue,
  existingComments: { content: string; timestamp: Date }[]
): { content: string; author: string; timestamp: string }[] {
  const pulled: { content: string; author: string; timestamp: string }[] = [];
  const comments = issue.comments || [];

  // Build a set of existing comment contents for dedup
  const existingBodies = new Set(existingComments.map(c => c.content));

  for (const comment of comments) {
    // Skip comments that were synced FROM AgenFK
    if (isSyncedComment(comment.body)) continue;

    // Skip if we already have this comment content
    const content = comment.body;
    if (existingBodies.has(content)) continue;

    pulled.push({
      content,
      author: comment.author?.login || 'github',
      timestamp: comment.createdAt,
    });
  }

  return pulled;
}

/**
 * Pull all GitHub Issues for a project.
 * Returns structured results for the caller to persist.
 */
export function pullAll(
  mapping: GitHubRepoMapping,
  existingItems: AgenFKItem[],
  projectId: string
): { results: PullItemResult[]; items: (PullItemResult & { itemData?: Partial<AgenFKItem> })[] } {
  const issues = listIssues(mapping, { state: 'all' });

  // Build lookup by externalId (issue number)
  const itemByExternalId = new Map<string, AgenFKItem>();
  for (const item of existingItems) {
    if (item.externalId) {
      itemByExternalId.set(item.externalId, item);
    }
  }

  // Also build lookup by agenfk-id embedded in issue body
  const itemById = new Map<string, AgenFKItem>();
  for (const item of existingItems) {
    itemById.set(item.id, item);
  }

  const results: (PullItemResult & { itemData?: Partial<AgenFKItem> })[] = [];

  for (const issue of issues) {
    // Find matching AgenFK item
    const existingByNumber = itemByExternalId.get(String(issue.number));
    const embeddedId = extractItemId(issue.body || '');
    const existingById = embeddedId ? itemById.get(embeddedId) : null;
    const existing = existingByNumber || existingById || null;

    // Skip issues that have no AgenFK labels (not managed by us)
    const labelNames = issue.labels.map(l => l.name);
    const hasAgenfkLabel = labelNames.some(l => l.startsWith('status:') || l.startsWith('type:'));
    if (!existing && !hasAgenfkLabel) {
      continue; // Not an AgenFK-managed issue
    }

    const pullResult = pullItem(issue, existing, projectId);
    results.push(pullResult);
  }

  return { results, items: results };
}
