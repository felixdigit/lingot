import { readFileSync } from "node:fs";
import { VENTURE_KINDS, type VentureKind, type InterfaceEdge } from "./venture";

/**
 * The harness/v1 manifest -- the single control plane per project (Phase 0, 0.1).
 * Schema spec: docs/harness/02-manifest.md. Successor to lingot/v0 (venture.ts);
 * both coexist during migration (docs/harness/95-migration.md) -- a v0 manifest is
 * un-migrated, not broken. This module adds the type + validator only; the
 * compiler (0.2) and adopter (0.3) consume it. Parse-never-eval: the loader
 * JSON.parses and structurally validates; it never evaluates a field.
 */

export const HARNESS_SCHEMA_TAG = "harness/v1";

/** Identity + access boundary. */
export interface Identity {
  readonly name: string;
  readonly kind: VentureKind;
  readonly owners: readonly string[];
  readonly aliases?: { readonly repo?: string | null; readonly db?: string | null };
}

/** The kernel pin (pessimistic range; exact resolved -> harness.lock, 0.5). */
export interface KernelPin {
  readonly version: string;
}

/** L3 core: the wrapped loop anchor + the host<->agent boundary shape. */
export interface LoopBinding {
  readonly anchor: string; // e.g. "claude-agent-sdk"
  readonly boundary?: string; // e.g. "acp"
}

/** L2: allowed tiers (aliases resolved via the kernel tier registry) + rubric overrides + transport. */
export interface RoutingBlock {
  readonly tiers: readonly string[];
  readonly default?: string;
  readonly overrides?: Readonly<Record<string, string>>;
  readonly gateway?: string; // adopt-binding, e.g. "litellm"
}

/** L1: what compiles into the window. */
export interface ContextBlock {
  readonly blocks?: readonly string[];
  readonly charters?: string;
  readonly budget?: { readonly max_tokens?: number; readonly drop_order?: readonly string[] };
  readonly retrieval?: { readonly from?: string };
}

/** L4: MCP set + the allow/ask/deny/hidden permission grammar (deny-precedence; hidden = invisible). */
export interface ToolsBlock {
  readonly mcp?: readonly string[];
  readonly permissions?: {
    readonly allow?: readonly string[];
    readonly ask?: readonly string[];
    readonly deny?: readonly string[];
    readonly hidden?: readonly string[];
  };
}

/** L3 body: durable engine + topologies. */
export interface OrchestrationBlock {
  readonly engine?: string; // adopt-binding, e.g. "inngest"
  readonly topologies?: readonly string[];
}

/** L5: memory backend + store. store null = declared-stateless. */
export interface StateBlock {
  readonly memory?: { readonly backend?: string; readonly source?: string };
  readonly store?: { readonly project?: string; readonly schema?: string } | null;
}

/** L6: standard spans (non-overridable floor) + swappable sink + the cost metric. */
export interface ObservabilityBlock {
  readonly spans?: string; // floor: "otel-genai"
  readonly sink?: string;
  readonly cost_metric?: string; // default: "cost_per_accepted_change"
}

/** L7: eval suites + the gates that block promotion / tier-swap / kernel-bump. */
export interface EvaluationBlock {
  readonly suites?: readonly string[];
  readonly gates?: {
    readonly promote?: readonly string[];
    readonly tier_swap?: readonly string[];
    readonly kernel_bump?: readonly string[];
  };
}

/** L8: guardrails + the lethal-trifecta hard block (floor). */
export interface SafetyBlock {
  readonly guardrails?: readonly string[];
  readonly lethal_trifecta_block?: boolean;
}

/** L9: secret NAMES only. Values resolve machine-local at dispatch (docs/harness/18). */
export interface SecretsBlock {
  readonly refs?: readonly string[];
}

/** L10: retry/idempotency discipline over the durable engine. */
export interface ReliabilityBlock {
  readonly retries?: { readonly policy?: string };
  readonly idempotency?: "required" | "optional" | boolean;
}

/** S1: the project perimeter -- deploy scope + public-serve derive from this. */
export interface PerimeterBlock {
  readonly anchor?: string;
  readonly exclude?: readonly string[];
  /** deploy.root: where the deploy uploads from, relative to the anchor (e.g. "../.." for a repo-root deploy). Default ".". */
  readonly deploy?: { readonly scope?: string; readonly surface?: string; readonly root?: string };
  readonly public_serve?: { readonly allow?: readonly string[] };
}

/** L12: a loop declaration. eligibility is the 4-box gate (all true to compile as a loop). */
export interface Automation {
  readonly name: string;
  readonly trigger?: Readonly<Record<string, unknown>>;
  readonly eligibility?: {
    readonly repeats?: boolean;
    readonly auto_reject?: boolean;
    readonly end_to_end?: boolean;
    readonly objective_done?: boolean;
  };
}

/** L11: output targets the compiler emits + the adopter materializes. */
export interface AuthoringBlock {
  readonly emit?: readonly string[]; // e.g. ["agents-md", "claude-dir"]
}

export interface HarnessManifest {
  /** Schema tag: "harness/v1". */
  readonly harness: string;
  readonly identity: Identity;
  readonly kernel: KernelPin;
  /** The on/off switch the adopter reads (0.3). Default true. */
  readonly enabled?: boolean;
  readonly loop?: LoopBinding;
  readonly routing?: RoutingBlock;
  readonly context?: ContextBlock;
  readonly tools?: ToolsBlock;
  readonly orchestration?: OrchestrationBlock;
  readonly state?: StateBlock;
  readonly observability?: ObservabilityBlock;
  readonly evaluation?: EvaluationBlock;
  readonly safety?: SafetyBlock;
  readonly secrets?: SecretsBlock;
  readonly reliability?: ReliabilityBlock;
  readonly perimeter?: PerimeterBlock;
  readonly automations?: readonly Automation[];
  readonly authoring?: AuthoringBlock;
  readonly overlay?: {
    readonly contract?: string | null;
    readonly canon?: string | null;
    readonly product?: string | null;
  };
  readonly interfaces?: {
    readonly provides: readonly InterfaceEdge[];
    readonly consumes: readonly InterfaceEdge[];
  };
  /** Studio-kind only. */
  readonly studio?: { readonly scan: readonly string[]; readonly registry: string };
}

export interface HarnessManifestLoadResult {
  readonly manifest?: HarnessManifest;
  readonly errors: readonly string[];
}

/** Discriminates a harness/v1 manifest (tag "harness/v1" + identity block) from lingot/v0 or a block. */
export function isHarnessManifest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return obj.harness === HARNESS_SCHEMA_TAG && typeof obj.identity === "object" && obj.identity !== null;
}

/**
 * Parse-never-eval guard: reject any string value that carries shell command-
 * substitution (`$(...)`) -- the Crush footgun (docs/harness/02 Section 2). The
 * manifest is data; a field that would execute at render time is a hard error.
 */
function findExecutableContent(value: unknown, path: string, out: string[]): void {
  if (typeof value === "string") {
    if (value.includes("$(")) out.push(`${path}: executable content ("$(") in a manifest value -- parse-never-eval`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => findExecutableContent(v, `${path}[${i}]`, out));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) findExecutableContent(v, `${path}.${k}`, out);
  }
}

/** Load + structurally validate a harness/v1 manifest. Never throws on bad content. */
export function loadHarnessManifest(path: string): HarnessManifestLoadResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { errors: [`${path}: unreadable or invalid JSON (${(err as Error).message})`] };
  }
  if (!isHarnessManifest(raw)) {
    return { errors: [`${path}: not a harness/v1 manifest (no "harness": "harness/v1" tag + identity block)`] };
  }
  const m = raw as HarnessManifest;
  const errors: string[] = [];

  if (m.harness !== HARNESS_SCHEMA_TAG) errors.push(`${path}: unknown schema tag "${m.harness}"`);
  if (!m.identity?.name) errors.push(`${path}: identity.name missing`);
  if (!VENTURE_KINDS.includes(m.identity?.kind)) {
    errors.push(`${path}: identity.kind "${m.identity?.kind}" not one of ${VENTURE_KINDS.join("/")}`);
  }
  if (!Array.isArray(m.identity?.owners) || m.identity.owners.length === 0) {
    errors.push(`${path}: identity.owners must be a non-empty array`);
  }
  if (typeof m.kernel?.version !== "string" || m.kernel.version.length === 0) {
    errors.push(`${path}: kernel.version must be a non-empty pin (e.g. "~> 1.4")`);
  }
  if (m.interfaces !== undefined) {
    if (!Array.isArray(m.interfaces.provides) || !Array.isArray(m.interfaces.consumes)) {
      errors.push(`${path}: interfaces block must carry provides[] + consumes[]`);
    }
  }
  if (m.studio !== undefined) {
    if (!Array.isArray(m.studio.scan) || typeof m.studio.registry !== "string") {
      errors.push(`${path}: studio block must carry scan[] + registry`);
    }
  }
  if (Array.isArray(m.automations)) {
    m.automations.forEach((a, i) => {
      if (!a || typeof a.name !== "string" || a.name.length === 0) {
        errors.push(`${path}: automations[${i}] must carry a name`);
      }
    });
  }
  // parse-never-eval guard over the whole document.
  findExecutableContent(raw, path, errors);

  return errors.length > 0 ? { errors } : { manifest: m, errors: [] };
}
