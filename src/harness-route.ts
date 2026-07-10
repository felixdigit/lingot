import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { tierEnv, leanRun, measuredClaudeRun } from "./harness-dispatch";
import { KERNEL_TIER_REGISTRY, KERNEL_DEFAULTS } from "./harness-kernel";
import { recordDispatch } from "./harness-usage";
import { readGateLedger } from "./harness-gates";
import { loadHarnessManifest } from "./harness-manifest";
import { resolveProject } from "./harness-merge";
import { tierToModel } from "./harness-exec";
import { refuteOutput } from "./harness-refute";
import { moderationCheck } from "./harness-rails";

/**
 * Verified routing (docs/harness/routing-and-verify.md). The core of the running
 * harness's tier discipline: route a LABOR unit to a cheap tier only when it is
 * PROVEN (A9) and its output passes an EXTERNAL, OBJECTIVE check; otherwise run
 * on the judgment lane (Max subscription -- the trusted floor). maker != checker:
 * the tier that produced the output never grades it (the check is code, not the
 * model). This structurally prevents the Ralph Wiggum failure (a confident-wrong
 * cheap answer shipping unverified -- e.g. GLM's "101").
 *
 * Two phases:
 *  A. proven? -- (workType, cheapTier) must have passed its tier_swap gate.
 *  B. check every live cheap output -- pass -> accept; fail -> escalate to the
 *     judgment lane (bounded: at most once). If the floor also fails, hard-fail.
 */

export type Check =
  | { readonly kind: "equals"; readonly value: string }
  | { readonly kind: "contains"; readonly value: string }
  | { readonly kind: "regex"; readonly pattern: string; readonly flags?: string }
  | { readonly kind: "command"; readonly command: string };

export interface LaborUnit {
  readonly prompt: string;
  readonly workType: string;
  readonly check: Check;
  /** Cheap tier to try (default "bulk"). */
  readonly tier?: string;
  /** Role (default "labor"). The A10 floor: only "labor" can ever route cheap; gate/refuter/orchestrator/judgment stay premium. */
  readonly role?: string;
  /** High-stakes: a cheap output must ALSO survive an adversarial refuter panel (judgment lane) to be accepted. */
  readonly refute?: { readonly n?: number };
}

export interface RouteResult {
  readonly text: string;
  /** Tier whose output PASSED the check, or "<none>" on hard-fail. */
  readonly acceptedTier: string;
  readonly role: string;
  /** The A10 floor kept a non-labor role on the judgment lane. */
  readonly flooredByRole: boolean;
  readonly proven: boolean;
  readonly triedCheap: boolean;
  readonly escalated: boolean;
  readonly checkPassed: boolean;
  readonly costUsd: number;
  readonly exit: number;
}

const norm = (s: string): string => s.trim();

/** The EXTERNAL objective check (maker != checker). Deterministic. */
export function runCheck(check: Check, output: string, cwd: string): boolean {
  switch (check.kind) {
    case "equals":
      return norm(output) === norm(check.value);
    case "contains":
      return output.includes(check.value);
    case "regex":
      try {
        // ReDoS guard (audit M5): a user regex against unbounded model output can
        // backtrack catastrophically -- test a bounded sample.
        const sample = output.length > 65536 ? output.slice(0, 65536) : output;
        return new RegExp(check.pattern, check.flags).test(sample);
      } catch {
        return false;
      }
    case "command": {
      const r = spawnSync("bash", ["-c", check.command], { cwd, input: output, encoding: "utf8", timeout: 30_000 });
      return (r.status ?? 1) === 0;
    }
  }
}

/** Phase A: has (workType, tier) been PROVEN good enough -- its tier_swap gate passed? (A9) */
export function isTierSwapProven(anchor: string, workType: string, tier: string): boolean {
  return readGateLedger(anchor)[`tier_swap:${workType}:${tier}`]?.passed === true;
}

/** Run a text prompt on a judgment tier (Max subscription) -- strip overrides so it never bills credits. */
function subscriptionText(prompt: string, tier: string, model: string): { text: string; costUsd: number; inTokens: number; outTokens: number; exit: number } {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const m = measuredClaudeRun(prompt, env, KERNEL_TIER_REGISTRY[tier]?.price, model);
  return { text: m.text, costUsd: m.costUsd, inTokens: m.inTokens, outTokens: m.outTokens, exit: m.exit };
}

export async function routeVerified(manifestPath: string, unit: LaborUnit): Promise<RouteResult> {
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) throw new Error(`harness route: ${load.errors.join("; ")}`);
  const res = resolveProject(KERNEL_DEFAULTS, load.manifest);
  if (!res.resolved) throw new Error(`harness route: ${res.errors.join("; ")}`);
  const anchor = dirname(manifestPath);
  // Judgment lane comes from the manifest's routing (kernel default folds in), not a literal.
  const judgmentTier = res.resolved.routing?.default ?? KERNEL_DEFAULTS.routing?.default ?? "scoped";
  const judgmentModel = tierToModel(judgmentTier);

  const role = unit.role ?? "labor";
  const isLabor = role === "labor";
  const cheapTier = unit.tier ?? "bulk";
  // A10 floor: only labor is ever cheap-eligible; gate/refuter/orchestrator/judgment stay premium.
  const proven = isLabor && isTierSwapProven(anchor, unit.workType, cheapTier);
  let costUsd = 0;
  let triedCheap = false;

  if (proven) {
    const te = tierEnv(cheapTier);
    if (!(te.missing && te.missing.length)) {
      triedCheap = true;
      const m = await leanRun(unit.prompt, te.env ?? {}, KERNEL_TIER_REGISTRY[cheapTier]?.price);
      costUsd += m.costUsd;
      let passed = m.exit === 0 && runCheck(unit.check, m.text, anchor);
      // Output rail (17): a flagged output never ships from the cheap lane --
      // treated like a failed check (escalate). Inactive rail = no-op (honest skip).
      if (passed) {
        const rail = await moderationCheck(m.text);
        if (rail.flagged) passed = false;
      }
      // High-stakes (16, adversarial verification): a passing cheap output must
      // ALSO survive the refuter panel; a refuted output escalates like a failed check.
      if (passed && unit.refute) {
        const rf = await refuteOutput(unit.prompt, m.text, { n: unit.refute.n });
        if (!rf.survived) passed = false;
      }
      recordDispatch(anchor, {
        at: new Date().toISOString(),
        tier: cheapTier,
        provider: "metered",
        model: KERNEL_TIER_REGISTRY[cheapTier]?.model ?? "?",
        role: "labor",
        exit: passed ? 0 : 1,
        inTokens: m.inTokens,
        outTokens: m.outTokens,
        costUsd: m.costUsd,
      });
      if (passed) {
        return { text: m.text, acceptedTier: cheapTier, role, flooredByRole: false, proven, triedCheap: true, escalated: false, checkPassed: true, costUsd, exit: 0 };
      }
      // cheap failed its check (or was refuted) -> escalate (bounded: once)
    }
  }

  // Judgment lane: not proven, or cheap failed. The trusted floor.
  const j = subscriptionText(unit.prompt, judgmentTier, judgmentModel);
  costUsd += j.costUsd;
  const jpassed = j.exit === 0 && runCheck(unit.check, j.text, anchor);
  recordDispatch(anchor, {
    at: new Date().toISOString(),
    tier: judgmentTier,
    provider: "anthropic (subscription)",
    model: judgmentModel,
    role: "judgment",
    exit: jpassed ? 0 : 1,
    inTokens: j.inTokens,
    outTokens: j.outTokens,
    costUsd: j.costUsd,
  });
  return {
    text: j.text,
    acceptedTier: jpassed ? "subscription" : "<none>",
    role,
    flooredByRole: !isLabor,
    proven,
    triedCheap,
    escalated: triedCheap,
    checkPassed: jpassed,
    costUsd,
    exit: jpassed ? 0 : 1,
  };
}

export function parseCheck(spec: string): Check {
  const i = spec.indexOf(":");
  const kind = i === -1 ? spec : spec.slice(0, i);
  const rest = i === -1 ? "" : spec.slice(i + 1);
  switch (kind) {
    case "equals": return { kind: "equals", value: rest };
    case "contains": return { kind: "contains", value: rest };
    case "command": return { kind: "command", command: rest };
    case "regex": {
      const m = rest.match(/^\/(.*)\/([a-z]*)$/);
      return m ? { kind: "regex", pattern: m[1], flags: m[2] } : { kind: "regex", pattern: rest };
    }
    default:
      // A typo'd kind silently becoming a contains-check would make everything
      // escalate (costly) or, worse, pass vacuously (audit L2) -- fail loudly.
      throw new Error(`unknown check kind "${kind}" -- use equals:<v> | contains:<v> | regex:/<re>/<flags> | command:<cmd>`);
  }
}

export function formatRouteResult(r: RouteResult): string {
  const path = r.flooredByRole
    ? `role "${r.role}" -> judgment floor (A10: never cheap)`
    : !r.proven
      ? "not proven -> judgment lane (A9: no un-proven downshift)"
      : r.escalated
        ? "cheap FAILED check -> escalated to judgment"
        : "cheap PASSED check -> accepted on the cheap tier";
  return `route: ${path}\n  accepted on: ${r.acceptedTier}; check ${r.checkPassed ? "PASS" : "FAIL"}; est $${r.costUsd.toFixed(5)}`;
}
