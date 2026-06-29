// Pure helpers for the saved-queries panel.

export interface SavedQuery {
  id: string;
  name: string;
  sql: string;
  description?: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A saved query needs both a non-blank name and non-blank SQL. */
export function canSaveQuery(name: string, sql: string): boolean {
  return name.trim().length > 0 && sql.trim().length > 0;
}
