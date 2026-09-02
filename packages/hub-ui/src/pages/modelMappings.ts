/**
 * Pure grouping/validation logic for the admin Models page, kept out of the
 * component so it is testable without a DOM (same reasoning as hiddenPeople.ts
 * and retiredInstallations.ts).
 */

export interface MappingRow {
  aliasModel: string;
  canonicalModel: string;
  createdByUserId: string | null;
  createdByEmail: string | null;
  createdAt: string;
}

export interface ObservedModel {
  model: string;
  prs: number;
  canonicalModel: string;
  isMapped: boolean;
}

/** One desired model, with every reported spelling folded under it. */
export interface ModelGroup {
  /** The name the admin chose, shown in the "desired name" column. */
  canonicalModel: string;
  /** Total PRs across the canonical name and all of its aliases. */
  prs: number;
  /** Reported ids that resolve to this name, including the canonical itself. */
  aliases: ObservedModel[];
  /** True when the canonical name has been reported at least once. */
  canonicalSeen: boolean;
  /** Mappings that exist but whose alias has never been seen in events. */
  unusedMappings: MappingRow[];
  /** Who created the mappings behind this group. */
  createdBy: string | null;
}

/**
 * Fold observed model ids into groups keyed by desired name.
 *
 * A canonical name gets its own group even when it has never been reported, so
 * the admin can see a mapping they created whose alias has not appeared (yet)
 * rather than wondering whether it took effect.
 */
export function groupModels(mappings: MappingRow[], observed: ObservedModel[]): ModelGroup[] {
  const groups = new Map<string, ModelGroup>();
  const ensure = (canonicalModel: string): ModelGroup => {
    let g = groups.get(canonicalModel);
    if (!g) {
      g = {
        canonicalModel, prs: 0, aliases: [], canonicalSeen: false,
        unusedMappings: [], createdBy: null,
      };
      groups.set(canonicalModel, g);
    }
    return g;
  };

  for (const o of observed) {
    const g = ensure(o.canonicalModel);
    g.aliases.push(o);
    g.prs += o.prs;
    if (o.model === o.canonicalModel) g.canonicalSeen = true;
  }

  for (const m of mappings) {
    const g = ensure(m.canonicalModel);
    if (!g.createdBy && m.createdByEmail) g.createdBy = m.createdByEmail;
    // A mapping whose alias never appears in events: kept visible, because a
    // silently-dead mapping is indistinguishable from one that never saved.
    if (!g.aliases.some(a => a.model === m.aliasModel)) g.unusedMappings.push(m);
  }

  return [...groups.values()]
    .map(g => ({
      ...g,
      aliases: [...g.aliases].sort((a, b) => b.prs - a.prs || a.model.localeCompare(b.model)),
      unusedMappings: [...g.unusedMappings].sort((a, b) => a.aliasModel.localeCompare(b.aliasModel)),
    }))
    .sort((a, b) => b.prs - a.prs || a.canonicalModel.localeCompare(b.canonicalModel));
}

/**
 * Validate a proposed mapping. Returns an error message, or null when valid.
 *
 * Mirrors the server's rules so the admin sees the problem before the request,
 * but the server remains authoritative — these are not a security boundary.
 */
export function validateMapping(
  aliasModel: string,
  canonicalModel: string,
  existing: MappingRow[],
): string | null {
  const alias = aliasModel.trim();
  const canonical = canonicalModel.trim();
  if (!alias) return 'Enter the model name as it is being reported today.';
  if (!canonical) return 'Enter the name you want it to appear as.';
  if (alias.length > 200 || canonical.length > 200) return 'Model names are limited to 200 characters.';
  if (alias === canonical) return 'These are the same name — there is nothing to map.';

  const clash = existing.find(m => m.aliasModel === alias);
  if (clash && clash.canonicalModel !== canonical) {
    return `"${alias}" is already mapped to "${clash.canonicalModel}". Delete that mapping first.`;
  }
  const chain = existing.find(m => m.aliasModel === canonical);
  if (chain) {
    return `"${canonical}" is itself mapped to "${chain.canonicalModel}". Map "${alias}" to that final name instead.`;
  }
  return null;
}

/**
 * Aliases already mapped, offered as the desired name when adding another
 * spelling — so a third spelling lands in the existing group instead of
 * starting a second one for the same model.
 */
export function knownCanonicalNames(mappings: MappingRow[]): string[] {
  return [...new Set(mappings.map(m => m.canonicalModel))].sort((a, b) => a.localeCompare(b));
}
