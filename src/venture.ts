import { readFileSync } from "node:fs";

/**
 * Venture manifest (`lingot.json` at a venture anchor), schema lingot/v0.
 * The block-level manifest (blocks/*\/lingot.json) promoted one level: the
 * venture declares WHAT it is; Lingot verdicts WHETHER it is that (doctor, P3).
 * Spec: ~/work/overwatch/docs/founder/harness-structure.md (RULED 2026-07-03).
 */

export type VentureKind = "venture" | "studio" | "workshop" | "channel";

export const VENTURE_KINDS: readonly VentureKind[] = [
  "venture",
  "studio",
  "workshop",
  "channel",
];

/** One edge of the org map: something a venture provides or consumes. */
export interface InterfaceEdge {
  readonly name: string;
  /** Provider venture name, on consume edges. */
  readonly of?: string;
  /** live | planned | building | ... free-form for v0. */
  readonly status?: string;
  readonly notes?: string;
}

export interface VentureIdentity {
  readonly name: string;
  readonly kind: VentureKind;
  /** The access boundary. */
  readonly owners: readonly string[];
  /** Legacy names: ends the ortova/overwatch/nexod_platform confusion mechanically. */
  readonly aliases?: { readonly repo?: string | null; readonly db?: string | null };
}

export interface VentureHarness {
  /** Kernel version pin. null = organic harness, pre-Lingot (pin lands at P3/P4). */
  readonly kernel: string | null;
  /** Module set by venture profile: zone-set, data-ops, co-owner{with,scoped}, comms, deploy, design. */
  readonly modules: Readonly<Record<string, unknown>>;
  readonly overlay?: {
    readonly contract?: string | null;
    readonly canon?: string | null;
    readonly product?: string | null;
  };
}

export interface VentureManifest {
  /** Schema tag, "lingot/v0". */
  readonly manifest: string;
  /** Parked manifests only: the anchor directory this manifest belongs to. */
  readonly anchor?: string;
  /** Parked manifests only: provenance + hand-back note. */
  readonly parked?: string;
  readonly identity: VentureIdentity;
  readonly harness: VentureHarness;
  /** Living surfaces the doctor requires fresh. null = does not exist yet. */
  readonly state: Readonly<Record<string, string | null>>;
  readonly interfaces: {
    readonly provides: readonly InterfaceEdge[];
    readonly consumes: readonly InterfaceEdge[];
  };
  /** Studio-kind manifests only: where in-repo ventures anchor + the registry dir. */
  readonly studio?: { readonly scan: readonly string[]; readonly registry: string };
}

export interface ManifestLoadResult {
  readonly manifest?: VentureManifest;
  readonly errors: readonly string[];
}

/**
 * Discriminates a venture manifest from a block-level lingot.json
 * (blocks/* use name/domain/claude_globs, no identity block).
 */
export function isVentureManifest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.manifest === "string" && typeof obj.identity === "object";
}

/** Load + structurally validate a venture manifest. Never throws on bad content. */
export function loadVentureManifest(path: string): ManifestLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { errors: [`${path}: unreadable or invalid JSON (${(err as Error).message})`] };
  }
  if (!isVentureManifest(raw)) {
    return { errors: [`${path}: not a venture manifest (no manifest tag + identity block)`] };
  }
  const m = raw as VentureManifest;
  const errors: string[] = [];
  if (m.manifest !== "lingot/v0") errors.push(`${path}: unknown schema tag "${m.manifest}"`);
  if (!m.identity.name) errors.push(`${path}: identity.name missing`);
  if (!VENTURE_KINDS.includes(m.identity.kind)) {
    errors.push(`${path}: identity.kind "${m.identity.kind}" not one of ${VENTURE_KINDS.join("/")}`);
  }
  if (!Array.isArray(m.identity.owners) || m.identity.owners.length === 0) {
    errors.push(`${path}: identity.owners must be a non-empty array`);
  }
  if (typeof m.harness !== "object" || m.harness === null) {
    errors.push(`${path}: harness block missing`);
  }
  if (typeof m.state !== "object" || m.state === null) {
    errors.push(`${path}: state block missing`);
  }
  if (
    typeof m.interfaces !== "object" ||
    m.interfaces === null ||
    !Array.isArray(m.interfaces.provides) ||
    !Array.isArray(m.interfaces.consumes)
  ) {
    errors.push(`${path}: interfaces block must carry provides[] + consumes[]`);
  }
  return errors.length > 0 ? { errors } : { manifest: m, errors: [] };
}
