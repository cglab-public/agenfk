export type Params = ReadonlyArray<unknown>;

export interface RunResult {
  changes: number;
  lastInsertRowid?: number | bigint;
}

export interface HubDb {
  run(sql: string, params?: Params): Promise<RunResult>;
  get<T = unknown>(sql: string, params?: Params): Promise<T | undefined>;
  all<T = unknown>(sql: string, params?: Params): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
