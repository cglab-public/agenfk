interface IssueGateInput {
  targetVersion: string;
  versions: string[];
  loading: boolean;
}

export function canIssueDirective({ targetVersion, versions, loading }: IssueGateInput): boolean {
  if (loading) return false;
  if (versions.length === 0) return false;
  if (!targetVersion) return false;
  return versions.includes(targetVersion);
}
