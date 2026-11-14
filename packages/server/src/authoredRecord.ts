/**
 * The authoredTests record, by reference (TASK 55fddd92, BUG ec325925).
 *
 * The check engine produces authoredTests as every test name in the suite when
 * the tests were written: test-count-not-lower since test-authoring needs the
 * pre-existing names as well as the card's new ones. Those are the names of the
 * capture the step just took, less the new tests another card's claim owns. So
 * the record stores only those exclusions and carries the capture's own results
 * as `tests`: storage keeps them as the capture's blob (same JSON, same hash),
 * and the record's reference keeps the blob alive once the capture is pruned.
 * The engine still sees a list of names: the server expands it before reading.
 */

type Named = { name: string };
interface Compacted {
  value: unknown;
  tests?: Named[];
}

/** What to store for the produced names, given the capture they came from. */
export function compactAuthored(names: unknown, capture: { tests?: Named[] } | null | undefined): Compacted {
  const tests = capture?.tests;
  if (!Array.isArray(names) || !Array.isArray(tests)) return { value: names };
  const authored = new Set(names.map(String));
  // Not exactly the capture's names in its order (one missing, duplicated or moved):
  // keep the names, never a reference that would read back differently.
  const order = tests.map(t => t.name).filter(n => authored.has(n));
  if (order.length !== names.length || order.some((n, i) => n !== String(names[i]))) return { value: names };
  return { value: { fromCapture: true, excluded: tests.map(t => t.name).filter(n => !authored.has(n)) }, tests };
}

/** The names a stored record stands for; undefined when its results cannot be read. */
export function expandAuthored(record: any): string[] | undefined {
  const value = record?.value;
  if (Array.isArray(value)) return value.map(String);
  if (!value || value.fromCapture !== true) return undefined;
  if (record.testsMissing || !Array.isArray(record.tests)) return undefined;
  const excluded = new Set<string>((value.excluded ?? []).map(String));
  return record.tests.map((t: Named) => t.name).filter((n: string) => !excluded.has(n));
}
