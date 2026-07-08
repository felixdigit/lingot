import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadHarnessManifest } from "./harness-manifest";
import { resolveProject } from "./harness-merge";
import { KERNEL_DEFAULTS, KERNEL_VERSION, KERNEL_TIER_REGISTRY } from "./harness-kernel";
import { compileTargets, type CompiledArtifact } from "./harness-emit";
import { computeVerdict, type Verdict, type VerdictProbes } from "./harness-verdict";

/**
 * The adopter (Phase 0, 0.3b) -- the executed switch (docs/harness/05). Load ->
 * resolve (kernel (+) overlay) -> compile -> materialize shadow -> live ->
 * compute the connectivity verdict. Replaces the old manual "copy shadow into
 * .claude/" step. The only thing that makes a compiled artifact live.
 */

export interface MaterializeResult {
  readonly written: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Write compiled artifacts to live paths under targetRoot. Idempotent (content-
 * addressed, DO-NOT-EDIT headers in the content). Complete-or-rollback: on any
 * write failure, the files written so far are removed and the error returned --
 * there is no half-adopted state.
 */
export function materialize(artifacts: readonly CompiledArtifact[], targetRoot: string): MaterializeResult {
  const written: string[] = [];
  for (const a of artifacts) {
    const full = join(targetRoot, a.path);
    try {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, a.content);
      written.push(full);
    } catch (err) {
      for (const w of written) {
        try {
          unlinkSync(w);
        } catch {
          /* best-effort rollback */
        }
      }
      return { written: [], errors: [`${full}: ${(err as Error).message} (rolled back ${written.length} file(s))`] };
    }
  }
  return { written, errors: [] };
}

export interface AdoptResult {
  readonly verdict?: Verdict;
  readonly artifacts: readonly CompiledArtifact[];
  readonly written: readonly string[];
  readonly errors: readonly string[];
}

export interface AdoptOptions {
  /** Where to materialize. Default: the manifest's own directory. */
  readonly targetRoot?: string;
  /** Env-dependent verdict probes (secrets/MCP). */
  readonly probes?: VerdictProbes;
  /** false = compute the verdict without writing anything live (a dry boot). Default true. */
  readonly write?: boolean;
}

/** Load + resolve + compile + (optionally) materialize + verdict. */
export function adopt(manifestPath: string, opts: AdoptOptions = {}): AdoptResult {
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) return { artifacts: [], written: [], errors: load.errors };
  const res = resolveProject(KERNEL_DEFAULTS, load.manifest);
  if (!res.resolved) return { artifacts: [], written: [], errors: res.errors };

  const artifacts = compileTargets(res.resolved, KERNEL_VERSION, KERNEL_TIER_REGISTRY);
  const targetRoot = opts.targetRoot ?? dirname(manifestPath);

  let written: readonly string[] = [];
  let errors: readonly string[] = [];
  if (opts.write !== false) {
    const m = materialize(artifacts, targetRoot);
    written = m.written;
    errors = m.errors;
  }

  // The registry-backed tier resolver is always on; callers may add secret/MCP probes.
  const probes = { resolveTier: (alias: string) => alias in KERNEL_TIER_REGISTRY, ...opts.probes };
  const verdict = computeVerdict(res.resolved, KERNEL_VERSION, artifacts, probes);
  return { verdict, artifacts, written, errors };
}
