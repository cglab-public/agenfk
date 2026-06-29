export type Params = ReadonlyArray<unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface HubDb {
  /** Which backend this handle talks to — lets dialect-aware callers (e.g. the
   *  admin DB-console schema introspection) branch on catalog source. */
  readonly backend: 'sqlite' | 'postgres';
  run(sql: string, params?: Params): Promise<RunResult>;
  get<T = unknown>(sql: string, params?: Params): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: Params): Promise<T[]>;
  /**
   * Execute ad-hoc SQL with ENGINE-LEVEL read-only enforcement — the
   * authoritative read-only boundary for the admin DB console (the keyword
   * guard is only a first line). SQLite runs under `PRAGMA query_only`;
   * Postgres runs inside a `READ ONLY` transaction with a statement timeout.
   * The SQL is executed VERBATIM (no SQLite→PG dialect rewriting), so operators
   * like jsonb `?` survive. Intended for trusted-but-arbitrary SQL only.
   */
  readonlyAll<T = unknown>(sql: string, timeoutMs?: number): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
