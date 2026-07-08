import type { HarnessManifest } from "./harness-manifest";

/**
 * kernel (+) overlay deep-merge -- the core compile mechanic (Phase 0, 0.2a).
 * Semantics per docs/harness/02-manifest.md Section 2: scalars OVERRIDE,
 * arrays CONCAT + DEDUP, objects DEEP-MERGE; the overlay (the project manifest)
 * wins on conflict (last-wins, additive-local). A declared non-overridable band
 * (the managed floor) may NOT be set by an overlay -- doing so is a hard error.
 */

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Concat two arrays and drop duplicates by structural value (stable stringify). */
function concatDedup(base: readonly unknown[], overlay: readonly unknown[]): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const el of [...base, ...overlay]) {
    const key = JSON.stringify(el);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(el);
    }
  }
  return out;
}

/**
 * Deep-merge overlay onto base. Both are treated as JSON-ish data. Overlay wins
 * on scalar conflict; arrays concat+dedup; objects recurse. An undefined overlay
 * value leaves the base value in place.
 */
export function deepMerge(base: unknown, overlay: unknown): unknown {
  if (overlay === undefined) return base;
  if (base === undefined) return overlay;
  if (Array.isArray(base) && Array.isArray(overlay)) return concatDedup(base, overlay);
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Plain = { ...base };
    for (const key of Object.keys(overlay)) out[key] = deepMerge(base[key], overlay[key]);
    return out;
  }
  // scalar, or a type mismatch: the overlay wins.
  return overlay;
}

/**
 * The non-overridable managed band: dotted paths the kernel owns and an overlay
 * may not set (docs/harness/02 Section 5). Kept a small, honest list for 0.2a --
 * the concrete single-key floors. The routing route-by-judgment rubric + the
 * judgment/gate tier floor are a rule, not a single key; they are enforced at the
 * routing resolve stage (a later 0.2 slice), not here.
 */
export const MANAGED_PATHS: readonly string[] = [
  "observability.spans",
  "safety.lethal_trifecta_block",
];

/** Read a dotted path out of a plain object, or undefined if any hop is absent. */
function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isPlainObject(o) ? o[k] : undefined), obj);
}

/** Return an error per managed path the overlay illegally sets. */
export function enforceManagedBand(overlay: unknown, managed: readonly string[] = MANAGED_PATHS): string[] {
  const errors: string[] = [];
  for (const path of managed) {
    if (getPath(overlay, path) !== undefined) {
      errors.push(`overlay sets managed (non-overridable) key "${path}" -- owned by the kernel, cannot be overridden`);
    }
  }
  return errors;
}

export interface ResolveResult {
  /** The fully-resolved project config the compiler renders targets from. Absent on error. */
  readonly resolved?: HarnessManifest;
  readonly errors: readonly string[];
}

/**
 * Resolve a project: enforce the managed band on the overlay, then deep-merge the
 * kernel defaults with the project manifest. The result is the single resolved
 * config every compile target (0.2b+) renders from. Deterministic (no clock, no
 * network, no randomness) so the compile stays replayable (docs/harness/03).
 */
export function resolveProject(kernelDefaults: Partial<HarnessManifest>, manifest: HarnessManifest): ResolveResult {
  const bandErrors = enforceManagedBand(manifest);
  if (bandErrors.length > 0) return { errors: bandErrors };
  const resolved = deepMerge(kernelDefaults, manifest) as HarnessManifest;
  return { resolved, errors: [] };
}
