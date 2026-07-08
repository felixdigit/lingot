import type { HarnessManifest } from "./harness-manifest";
import type { CompiledArtifact } from "./harness-emit";

/**
 * The connectivity verdict (Phase 0, 0.3a) -- the "am I wired?" readout the
 * adopter emits at session start (docs/harness/05 + axiom A6). It PROVES the
 * live session rather than assuming it: consistency (the doctor) is not
 * connection (this). Pure + deterministic: env-dependent checks (secret
 * resolution, MCP reachability) are injected as probes; absent a probe, the
 * check reports "skipped (pending wiring)" honestly rather than pretending.
 */

export type CheckStatus = "ok" | "degraded" | "blocked" | "skipped";
export type VerdictLevel = "WIRED" | "DEGRADED" | "BLOCKED" | "OFF";

export interface VerdictCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface Verdict {
  readonly project: string;
  readonly kernel: string;
  readonly enabled: boolean;
  readonly checks: readonly VerdictCheck[];
  readonly level: VerdictLevel;
}

/** Env-dependent probes, injected so computeVerdict stays pure/testable. Absent -> the check is skipped. */
export interface VerdictProbes {
  /** Machine-local secret resolver (L9). Returns whether a ref name resolves. */
  readonly resolveSecret?: (name: string) => boolean;
  /** MCP reachability probe. Returns whether a server is reachable. */
  readonly probeMcp?: (server: string) => boolean;
  /** Tier resolver (against the kernel tier registry). Returns whether an alias resolves. */
  readonly resolveTier?: (alias: string) => boolean;
  /** Declared promote-gates not yet passed (docs/harness/16). Non-empty -> BLOCKED (not-adoptable). */
  readonly unmetGates?: readonly string[];
}

/**
 * Assess a resolved project + its compiled artifacts into a structured verdict.
 * BLOCKED if any check is blocked; DEGRADED if any is degraded; else WIRED.
 * Skipped checks (probe not wired) do not downgrade the level but are surfaced,
 * so a WIRED verdict is honest about what it could not yet assert.
 */
export function computeVerdict(
  resolved: HarnessManifest,
  kernelVersion: string,
  artifacts: readonly CompiledArtifact[],
  probes: VerdictProbes = {},
): Verdict {
  const project = resolved.identity.name;
  const enabled = resolved.enabled !== false;
  if (!enabled) return { project, kernel: kernelVersion, enabled, checks: [], level: "OFF" };

  const checks: VerdictCheck[] = [];

  if (probes.unmetGates && probes.unmetGates.length > 0) {
    checks.push({ name: "gates", status: "blocked", detail: `promote gate(s) not passed: ${probes.unmetGates.join(",")}` });
  }

  const blocks = resolved.context?.blocks ?? [];
  checks.push({ name: "context", status: blocks.length ? "ok" : "skipped", detail: `${blocks.length} block(s)` });

  const tiers = resolved.routing?.tiers ?? [];
  if (!tiers.length) {
    checks.push({ name: "tiers", status: "blocked", detail: "no tiers declared or inherited" });
  } else if (probes.resolveTier) {
    const bad = tiers.filter((t) => !probes.resolveTier!(t));
    const def = resolved.routing?.default;
    const defBad = def ? !probes.resolveTier(def) : false;
    const status: CheckStatus = bad.length === 0 ? "ok" : defBad || bad.length === tiers.length ? "blocked" : "degraded";
    checks.push({
      name: "tiers",
      status,
      detail: bad.length === 0 ? `${tiers.length} resolvable (${tiers.join(",")})` : `unresolvable: ${bad.join(",")}`,
    });
  } else {
    checks.push({ name: "tiers", status: "skipped", detail: `${tiers.length} declared, registry not wired` });
  }

  if (resolved.perimeter?.deploy) {
    const hasArtifact = artifacts.some((a) => a.target === "deploy-scope");
    checks.push({
      name: "perimeter",
      status: hasArtifact ? "ok" : "blocked",
      detail: hasArtifact
        ? `enforced (${resolved.perimeter.exclude?.length ?? 0} excludes)`
        : "deploy surface declared but no deploy-scope artifact compiled",
    });
  } else {
    checks.push({ name: "perimeter", status: "skipped", detail: "no deploy surface" });
  }

  const refs = resolved.secrets?.refs ?? [];
  if (probes.resolveSecret && refs.length) {
    const unresolved = refs.filter((r) => !probes.resolveSecret!(r));
    checks.push({
      name: "secrets",
      status: unresolved.length ? "blocked" : "ok",
      detail: unresolved.length ? `unresolvable: ${unresolved.join(",")}` : `${refs.length}/${refs.length} resolvable`,
    });
  } else {
    checks.push({ name: "secrets", status: "skipped", detail: refs.length ? `${refs.length} ref(s), resolver not wired` : "no secret refs" });
  }

  const mcp = resolved.tools?.mcp ?? [];
  if (probes.probeMcp && mcp.length) {
    const down = mcp.filter((s) => !probes.probeMcp!(s));
    checks.push({
      name: "mcp",
      status: down.length ? "degraded" : "ok",
      detail: down.length ? `unreachable: ${down.join(",")}` : `${mcp.length} reachable`,
    });
  } else {
    checks.push({ name: "mcp", status: "skipped", detail: mcp.length ? `${mcp.length} server(s), probe not wired` : "no mcp servers" });
  }

  const level: VerdictLevel = checks.some((c) => c.status === "blocked")
    ? "BLOCKED"
    : checks.some((c) => c.status === "degraded")
      ? "DEGRADED"
      : "WIRED";

  return { project, kernel: kernelVersion, enabled, checks, level };
}

const MARK: Record<CheckStatus, string> = { ok: "ok", skipped: "--", degraded: "!!", blocked: "XX" };

/** Human-readable readout for the terminal (the boot verdict). */
export function formatVerdict(v: Verdict): string {
  if (v.level === "OFF") return `harness: OFF  project=${v.project}  (enabled: false)`;
  const head = `harness: ON  project=${v.project}  kernel=${v.kernel}`;
  const lines = v.checks.map((c) => `  ${MARK[c.status]} ${c.name}: ${c.detail}`);
  const pending = v.checks.filter((c) => c.status === "skipped").map((c) => c.name);
  const foot = `  verdict: ${v.level}` + (pending.length ? ` (${pending.length} pending: ${pending.join(",")})` : "");
  return [head, ...lines, foot].join("\n");
}
