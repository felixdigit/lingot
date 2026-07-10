import { loadHarnessManifest } from "./harness-manifest";
import { resolveProject } from "./harness-merge";
import { KERNEL_DEFAULTS, KERNEL_VERSION, KERNEL_TIER_REGISTRY } from "./harness-kernel";
import { compileTargets } from "./harness-emit";
import { resolveSecret as machineLocalResolveSecret } from "./harness-secrets";
import { tierEnv } from "./harness-dispatch";
import { isEligible } from "./harness-automate";

/**
 * The harness/v1 doctor (Phase 0, 0.4) -- the STANDING conformance verdict
 * (docs/harness/05 Section 6), distinct from the per-boot connectivity verdict.
 * manifest declares WHAT; the doctor verdicts WHETHER. Runs at commit time. This
 * is the v1 doctor; the existing lingot doctor handles v0.
 *
 * Checks:
 *  - connected: every declared section that should compile a target actually
 *    produces one (the "built != connected" gap made real -- did the artifact
 *    materialize, not "is the name mentioned in a doc").
 *  - tiers: no declared tier is unresolvable against the kernel registry.
 *  - secrets: every secrets.refs name resolves machine-local (default: env);
 *    declared-but-unresolvable is red (docs/harness/18).
 *  - perimeter: a deploy surface must carry a non-empty exclude set (the S1
 *    footgun -- a deploy with no perimeter re-bloats).
 */

export type DoctorLevel = "red" | "yellow" | "ok";

export interface HarnessDoctorFinding {
  readonly check: string;
  readonly level: DoctorLevel;
  readonly message: string;
}

export interface HarnessDoctorReport {
  readonly project: string;
  readonly findings: readonly HarnessDoctorFinding[];
  readonly verdict: "green" | "yellow" | "red";
}

export interface DoctorOptions {
  /** Machine-local secret resolver. Default: process.env[name] is set + non-empty. */
  readonly resolveSecret?: (name: string) => boolean;
}

export function doctorProject(manifestPath: string, opts: DoctorOptions = {}): HarnessDoctorReport {
  const findings: HarnessDoctorFinding[] = [];
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) {
    return { project: manifestPath, findings: load.errors.map((m) => ({ check: "load", level: "red", message: m })), verdict: "red" };
  }
  const project = load.manifest.identity.name;
  const res = resolveProject(KERNEL_DEFAULTS, load.manifest);
  if (!res.resolved) {
    return { project, findings: res.errors.map((m) => ({ check: "resolve", level: "red", message: m })), verdict: "red" };
  }
  const resolved = res.resolved;
  const artifacts = compileTargets(resolved, KERNEL_VERSION, KERNEL_TIER_REGISTRY);
  const has = (target: string) => artifacts.some((a) => a.target === target);

  // connected: declared sections -> a compiled artifact.
  const expect: Array<[boolean, string, string]> = [
    [true, "agents-md", "operating instructions"],
    [!!resolved.routing?.tiers?.length, "tier-table", "routing.tiers"],
    [!!resolved.tools, "tool-set", "tools"],
    [!!resolved.perimeter?.deploy, "deploy-scope", "perimeter.deploy"],
  ];
  for (const [declared, target, label] of expect) {
    if (declared && !has(target)) findings.push({ check: "connected", level: "red", message: `${label} declared but no ${target} artifact compiled (built != connected)` });
  }

  // tiers: none unresolvable.
  const tiers = resolved.routing?.tiers ?? [];
  const badTiers = tiers.filter((t) => !(t in KERNEL_TIER_REGISTRY));
  if (badTiers.length) findings.push({ check: "tiers", level: "red", message: `routing.tiers reference unknown alias(es): ${badTiers.join(", ")}` });
  // tier-creds: a declared, known tier whose creds are not resolvable here (yellow -- may be intentional/unprovisioned).
  const unrunnable = tiers.filter((t) => t in KERNEL_TIER_REGISTRY).filter((t) => (tierEnv(t).missing?.length ?? 0) > 0);
  if (unrunnable.length) findings.push({ check: "tier-creds", level: "yellow", message: `declared tier(s) not runnable here (creds unset): ${unrunnable.join(", ")}` });

  // secrets: every ref resolves machine-local.
  const resolveSecret = opts.resolveSecret ?? machineLocalResolveSecret;
  const refs = resolved.secrets?.refs ?? [];
  const unresolved = refs.filter((r) => !resolveSecret(r));
  if (unresolved.length) findings.push({ check: "secrets", level: "red", message: `secrets.refs not resolvable machine-local: ${unresolved.join(", ")}` });

  // durability tripwire: eligible automations run machine-local (cron/launchd)
  // until adopted onto a durable engine. This yellow IS the "when do we need
  // Inngest" answer -- it stands until the loops either stay fine machine-local
  // or the felt trigger fires (must run laptop-closed / survive interruption /
  // retry across hours), at which point adopt Inngest per docs/harness/12.
  const eligibleLoops = (resolved.automations ?? []).filter((a) => isEligible(a));
  if (eligibleLoops.length > 0) {
    findings.push({
      check: "durability",
      level: "yellow",
      message: `${eligibleLoops.length} eligible automation(s) run machine-local; graduate to Inngest when a loop must run laptop-closed, survive interruption, or retry across hours (docs/harness/cron.md)`,
    });
  }

  // perimeter: deploy surface needs a non-empty exclude set.
  if (resolved.perimeter?.deploy && !(resolved.perimeter.exclude?.length)) {
    findings.push({ check: "perimeter", level: "red", message: "deploy surface declared but perimeter.exclude is empty (S1: deploy would re-bloat)" });
  }

  const verdict = findings.some((f) => f.level === "red") ? "red" : findings.some((f) => f.level === "yellow") ? "yellow" : "green";
  return { project, findings, verdict };
}

export function formatHarnessDoctorReport(r: HarnessDoctorReport): string {
  const head = `harness doctor: ${r.project}  verdict: ${r.verdict.toUpperCase()}`;
  if (r.findings.length === 0) return head + "\n  (no findings)";
  const mark: Record<DoctorLevel, string> = { red: "XX", yellow: "!!", ok: "ok" };
  return [head, ...r.findings.map((f) => `  ${mark[f.level]} [${f.check}] ${f.message}`)].join("\n");
}
