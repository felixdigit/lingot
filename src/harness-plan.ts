import { readFileSync } from "node:fs";
import { parseCheck, routeVerified, type LaborUnit } from "./harness-route";
import { runPool } from "./harness-topology";

/**
 * The multi-unit plan runner (docs/harness/work-orders/D-plan.md, L3 body). A
 * plan is a JSONL file, one PlanUnit per line -- the declared-role decomposition
 * input shape from routing-and-verify.md section 10.3. Each unit routes through
 * `routeVerified` (or a fake, for tests) sequentially; one bad unit does not kill
 * the run. Validation happens at load time (invariant 2, fail-closed): a labor
 * unit without both a workType and a check can never be dispatched, since there
 * would be no external objective check to gate it.
 *
 * Honesty note (docs/harness/work-orders/G-topology.md): `opts.concurrency > 1`
 * dispatches units through `runPool` (`harness-topology.ts`). TRUE concurrency
 * applies to the cheap lane (async fetch); judgment-lane units call a synchronous
 * `claude` spawn under the hood and will serialize on the event loop even inside
 * the pool -- correctness is unaffected, only wall-clock.
 */

export interface PlanUnit {
  readonly prompt: string;
  readonly workType?: string;
  readonly check?: string;
  readonly tier?: string;
  readonly role?: string;
  readonly refute?: { readonly n?: number };
}

export type RouteFn = typeof routeVerified;

export interface PlanResult {
  readonly results: readonly { unit: PlanUnit; text: string; acceptedTier: string; costUsd: number; exit: number }[];
  readonly errors: readonly string[];
  readonly totalCostUsd: number;
  readonly accepted: number;
  readonly failed: number;
}

/** Load + validate a plan. Fail-closed: a malformed line or an invalid labor unit becomes an error entry, never a crash. */
export function loadPlan(path: string): { units: PlanUnit[]; errors: string[] } {
  const units: PlanUnit[] = [];
  const errors: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return { units: [], errors: [`cannot read plan ${path}: ${(e as Error).message}`] };
  }

  raw.split("\n").forEach((rawLine, i) => {
    const lineNo = i + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return;

    let unit: PlanUnit;
    try {
      unit = JSON.parse(line) as PlanUnit;
    } catch (e) {
      errors.push(`line ${lineNo}: malformed JSON: ${(e as Error).message}`);
      return;
    }

    const role = unit.role ?? "labor";
    if (role === "labor") {
      const missing = [
        unit.workType ? null : "workType",
        unit.check ? null : "check",
      ].filter((m): m is string => m !== null);
      if (missing.length > 0) {
        errors.push(`line ${lineNo}: labor unit missing ${missing.join(" and ")}`);
        return;
      }
    }

    // Validate the check SPEC at load (fail-closed): parseCheck throws on an
    // unknown kind, and a mid-run throw would kill the plan -- load is the seam.
    if (unit.check) {
      try {
        parseCheck(unit.check);
      } catch (e) {
        errors.push(`line ${lineNo}: ${(e as Error).message}`);
        return;
      }
    }

    units.push(unit);
  });

  return { units, errors };
}

/** Only labor units are validated to carry a workType (loadPlan); other roles never read it (routeVerified short-circuits on role before use). */
function toLaborUnit(unit: PlanUnit): LaborUnit {
  return {
    prompt: unit.prompt,
    workType: unit.workType ?? "",
    check: unit.check ? parseCheck(unit.check) : { kind: "regex", pattern: "[\\s\\S]*" },
    tier: unit.tier,
    role: unit.role,
    refute: unit.refute,
  };
}

/**
 * Runner. Loader errors short-circuit (fail-closed) -- nothing dispatches when
 * the plan itself is invalid. `opts.concurrency` defaults to 1 (sequential,
 * unchanged); values > 1 dispatch through `runPool` -- results, totals, and
 * order are identical to the sequential path for the same outcomes.
 */
export async function runPlan(manifestPath: string, planPath: string, opts?: { route?: RouteFn; concurrency?: number }): Promise<PlanResult> {
  const { units, errors } = loadPlan(planPath);
  if (errors.length > 0) {
    return { results: [], errors, totalCostUsd: 0, accepted: 0, failed: 0 };
  }

  const route = opts?.route ?? routeVerified;
  const concurrency = opts?.concurrency ?? 1;
  const results: { unit: PlanUnit; text: string; acceptedTier: string; costUsd: number; exit: number }[] = [];
  let totalCostUsd = 0;
  let accepted = 0;
  let failed = 0;

  if (concurrency > 1) {
    const pooled = await runPool(units, (unit) => route(manifestPath, toLaborUnit(unit)), concurrency);
    for (let i = 0; i < pooled.length; i += 1) {
      const p = pooled[i];
      const unit = units[i];
      // A pool-level error (a rejecting route call) records as a failed unit
      // result, same shape as a checked failure -- the plan continues.
      const r = p.ok ? p.value : { text: `ERR: ${p.error}`, acceptedTier: "<none>", costUsd: 0, exit: 1 };
      results.push({ unit, text: r.text, acceptedTier: r.acceptedTier, costUsd: r.costUsd, exit: r.exit });
      totalCostUsd += r.costUsd;
      if (r.exit === 0) accepted += 1;
      else failed += 1;
    }
    return { results, errors: [], totalCostUsd, accepted, failed };
  }

  for (const unit of units) {
    const r = await route(manifestPath, toLaborUnit(unit));
    results.push({ unit, text: r.text, acceptedTier: r.acceptedTier, costUsd: r.costUsd, exit: r.exit });
    totalCostUsd += r.costUsd;
    if (r.exit === 0) accepted += 1;
    else failed += 1;
  }

  return { results, errors: [], totalCostUsd, accepted, failed };
}

export function formatPlanResult(r: PlanResult): string {
  if (r.errors.length > 0) {
    return [`plan: ${r.errors.length} loader error(s) -- nothing run`, ...r.errors.map((e) => `  ${e}`)].join("\n");
  }
  const lines = r.results.map(
    (res, i) => `  [${i}] tier=${res.acceptedTier} exit=${res.exit} cost=$${res.costUsd.toFixed(5)}`,
  );
  const costPerAccepted = r.accepted > 0 ? r.totalCostUsd / r.accepted : 0;
  return [
    `plan: ${r.results.length} unit(s) -- ${r.accepted} accepted, ${r.failed} failed`,
    ...lines,
    `total: $${r.totalCostUsd.toFixed(5)}; cost/accepted: $${costPerAccepted.toFixed(5)}`,
  ].join("\n");
}
