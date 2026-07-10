import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tierEnv, leanRun } from "./harness-dispatch";
import { KERNEL_TIER_REGISTRY } from "./harness-kernel";
import { recordGatePass } from "./harness-gates";
import { appendEvalOutcome } from "./harness-drift";

/**
 * The eval runner (Phase 3, docs/harness/16 -- the RUNNER the gate mechanism
 * plugs into). A suite lives at <anchor>/.harness/evals/<suite>.jsonl, one case
 * per line: {"prompt": "...", "expect": "substring or /regex/flags", "tier"?: "bulk"}.
 * Each case runs LEAN (direct model call, cheap) on its tier; the output is
 * checked against `expect` (deterministic: substring, or /regex/). All-pass ->
 * the suite records a gate-pass (harness-gates), which unblocks the adopter for a
 * promote-gated project. LLM-as-judge scoring is a follow-on; this is the
 * deterministic first slice.
 */

export interface EvalCase {
  readonly prompt: string;
  readonly expect: string;
  readonly tier?: string;
}

export interface EvalCaseResult {
  readonly ok: boolean;
  readonly detail: string;
}

export interface EvalReport {
  readonly suite: string;
  readonly total: number;
  readonly passed: number;
  readonly results: readonly EvalCaseResult[];
}

/** Match output against an expectation: `/re/flags` is a regex, else a substring. */
export function matchesExpect(output: string, expect: string): boolean {
  if (expect.startsWith("/") && expect.lastIndexOf("/") > 0) {
    const last = expect.lastIndexOf("/");
    try {
      return new RegExp(expect.slice(1, last), expect.slice(last + 1)).test(output);
    } catch {
      return false;
    }
  }
  return output.includes(expect);
}

export async function runEval(anchor: string, suite: string, defaultTier: string): Promise<EvalReport> {
  const path = join(anchor, ".harness", "evals", `${suite}.jsonl`);
  let cases: EvalCase[];
  try {
    cases = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => JSON.parse(l) as EvalCase);
  } catch (e) {
    return { suite, total: 0, passed: 0, results: [{ ok: false, detail: `cannot read ${path}: ${(e as Error).message}` }] };
  }

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const alias = c.tier ?? defaultTier;
    const resolved = tierEnv(alias);
    if (resolved.missing && resolved.missing.length > 0) {
      results.push({ ok: false, detail: `tier ${alias} HELD (${resolved.missing.join(", ")})` });
      continue;
    }
    const m = await leanRun(c.prompt, resolved.env ?? {}, KERNEL_TIER_REGISTRY[alias]?.price);
    const ok = m.exit === 0 && matchesExpect(m.text, c.expect);
    results.push({
      ok,
      detail: ok ? "pass" : `got "${m.text.replace(/\s+/g, " ").trim().slice(0, 60)}" want ${c.expect}`,
    });
  }
  const passed = results.filter((r) => r.ok).length;
  const report: EvalReport = { suite, total: cases.length, passed, results };
  if (cases.length > 0 && passed === cases.length) recordGatePass(anchor, suite, "harness eval");
  // Feed the learning loop (21): every eval outcome lands in the drift history.
  if (cases.length > 0) appendEvalOutcome(anchor, { at: new Date().toISOString(), suite, passed, total: cases.length });
  return report;
}

/**
 * The OFFLINE tier_swap proof (A9, routing-and-verify.md Phase A). Runs a
 * work-type's golden suite (.harness/evals/<workType>.jsonl) on a CANDIDATE tier
 * and, if the pass rate meets the threshold, records the `tier_swap:<workType>:
 * <tier>` gate that `routeVerified` reads before ever routing live work there.
 * This retires the manual `gate-pass` -- a tier is EARNED on golden data, not
 * asserted. Deterministic scoring (matchesExpect); LLM-judge is a follow-on.
 */
export interface TierProofReport {
  readonly workType: string;
  readonly tier: string;
  readonly total: number;
  readonly passed: number;
  readonly threshold: number;
  readonly proven: boolean;
  readonly results: readonly EvalCaseResult[];
}

export async function proveTier(anchor: string, workType: string, tier: string, threshold = 1.0): Promise<TierProofReport> {
  const path = join(anchor, ".harness", "evals", `${workType}.jsonl`);
  let cases: EvalCase[];
  try {
    cases = readFileSync(path, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => JSON.parse(l) as EvalCase);
  } catch (e) {
    return { workType, tier, total: 0, passed: 0, threshold, proven: false, results: [{ ok: false, detail: `cannot read ${path}: ${(e as Error).message}` }] };
  }

  const resolved = tierEnv(tier);
  if (resolved.missing && resolved.missing.length > 0) {
    return { workType, tier, total: cases.length, passed: 0, threshold, proven: false, results: [{ ok: false, detail: `tier ${tier} HELD (${resolved.missing.join(", ")})` }] };
  }

  const results: EvalCaseResult[] = [];
  for (const c of cases) {
    const m = await leanRun(c.prompt, resolved.env ?? {}, KERNEL_TIER_REGISTRY[tier]?.price);
    const ok = m.exit === 0 && matchesExpect(m.text, c.expect);
    results.push({ ok, detail: ok ? "pass" : `got "${m.text.replace(/\s+/g, " ").trim().slice(0, 60)}" want ${c.expect}` });
  }
  const passed = results.filter((r) => r.ok).length;
  const rate = cases.length > 0 ? passed / cases.length : 0;
  const proven = cases.length > 0 && rate >= threshold;
  if (proven) recordGatePass(anchor, `tier_swap:${workType}:${tier}`, `proved ${passed}/${cases.length} @ >=${threshold}`);
  // Drift history keys off the workType, so tier_swap:<workType>:* proofs revoke on decay (21).
  if (cases.length > 0) appendEvalOutcome(anchor, { at: new Date().toISOString(), suite: workType, tier, passed, total: cases.length });
  return { workType, tier, total: cases.length, passed, threshold, proven, results };
}

export function formatTierProof(r: TierProofReport): string {
  const head = `harness prove-tier: ${r.tier} on "${r.workType}" -- ${r.passed}/${r.total} passed (need >=${Math.round(r.threshold * 100)}%) -> ${r.proven ? "PROVEN (tier_swap gate recorded)" : "NOT proven"}`;
  return [head, ...r.results.map((c, i) => `  ${c.ok ? "ok" : "XX"} [${i + 1}] ${c.detail}`)].join("\n");
}

export function formatEvalReport(r: EvalReport): string {
  const head = `harness eval: ${r.suite} -- ${r.passed}/${r.total} passed${r.total > 0 && r.passed === r.total ? " (gate-pass recorded)" : ""}`;
  const lines = r.results.map((c, i) => `  ${c.ok ? "ok" : "XX"} [${i + 1}] ${c.detail}`);
  return [head, ...lines].join("\n");
}
