import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderTemplate } from "./harness-compile";
import { measuredClaudeRun, tierEnv, type MeasuredRun } from "./harness-dispatch";
import { KERNEL_TIER_REGISTRY } from "./harness-kernel";
import { recordGatePass } from "./harness-gates";
import { appendEvalOutcome } from "./harness-drift";

/**
 * The prompt gate (docs/harness/prompt-design.md P7; 16-evaluation A9) -- the
 * eval-gated prompt-change loop. A suite binds to a COMPILED PROMPT ARTIFACT
 * (kernel template or plain markdown) and runs a paired A/B: the committed
 * baseline (git HEAD) vs the working tree, rendered byte-identical except the
 * edit, composed with identical cases. Pairing controls the format-noise floor
 * the literature measures (research 195: up to 76pp from format alone), at the
 * honest price that verdicts are artifact-local. Floor cases tolerate zero
 * regression (deterministic assertions, IFEval-style); stat cases score a
 * paired mean delta with a CI (Miller 2411.00640); small suites resolve only
 * large effects, so an underpowered comparison returns INSUFFICIENT-n rather
 * than a fake verdict. The ship rule is a vector: floor AND stat AND cost.
 */

export interface PromptAssertion {
  readonly type: "contains" | "not_contains" | "regex" | "not_regex";
  readonly value: string;
  /** Regex flags (e.g. "i"). JS regex has no inline (?i) -- use this instead. */
  readonly flags?: string;
}

export interface PromptCase {
  readonly id: string;
  readonly class: "floor" | "stat";
  readonly task: string;
  readonly assertions: readonly PromptAssertion[];
}

export interface PromptSuite {
  readonly suite: string;
  readonly version: number;
  /** Repo-relative path of the prompt artifact under test. */
  readonly binds: string;
  /** Template-context overrides merged over the deterministic fixture. */
  readonly fixture?: Record<string, unknown>;
  /** Subject tier alias (the tier the artifact steers in production). */
  readonly tier?: string;
  readonly trials?: number;
  readonly cases: readonly PromptCase[];
}

export interface CaseResult {
  readonly id: string;
  readonly class: "floor" | "stat";
  /** Fraction of trials where every assertion passed, per arm (0..1). */
  readonly baseline: number;
  readonly candidate: number;
  readonly detail: string;
}

export type PromptGateVerdict =
  | "SHIP-OK"
  | "NO-SHIP (floor)"
  | "NO-SHIP (regression)"
  | "NO-SHIP (cost)"
  | "INSUFFICIENT-n"
  | "NO-CHANGE"
  | "CALIBRATE";

export interface PromptGateReport {
  readonly suite: string;
  readonly version: number;
  readonly binds: string;
  readonly artifactHash: string;
  readonly tier: string;
  readonly trials: number;
  readonly cases: readonly CaseResult[];
  readonly floorTotal: number;
  readonly floorPassedCandidate: number;
  readonly floorPassedBaseline: number;
  readonly statN: number;
  readonly meanDelta: number;
  readonly ci95: number;
  /** Smallest |delta| this suite can resolve at 95% -- the honest power line. */
  readonly resolvableDelta: number;
  readonly costBaselineUsd: number;
  readonly costCandidateUsd: number;
  readonly verdict: PromptGateVerdict;
  readonly notes: readonly string[];
}

/** A subject runner: composed prompt -> model output. Injectable for tests. */
export type SubjectRunner = (composed: string, tier: string) => Promise<MeasuredRun>;

/**
 * The deterministic fixture context: a synthetic venture covering every slot the
 * kernel templates declare, so a template renders with NO <UNRESOLVED:> markers
 * and the two arms differ only by the edit under test. Suite `fixture` entries
 * merge over these defaults (shallow per top-level key).
 */
export const FIXTURE_CONTEXT: Record<string, unknown> = {
  name: "testv",
  title: "Testv",
  founder: "Felix",
  aliases: { repo: "testv" },
  overlay: { product: "STRUCTURE.md", canon: "docs/canon/", contract: "AGENTS.md" },
  state: { worksite: "the worksite board", generator: "pnpm state", decisions: "decisions/decisions.md" },
  db: { schema: "testv" },
  dbProject: "testv-project",
  gateWallList: "deploy, spend",
  zone: 1,
  zoneSlug: "fixture",
  charter: {
    description: "fixture front: one job, clearly bounded",
    tools: "Read, Grep, Glob",
    scope: "the fixture front's single job; nothing outside it",
    invariant: "the fixture invariant holds at all times",
    "read-fresh": "- the fixture charter doc",
    procedure: "1. read the tile. 2. do the work. 3. verify. 4. park at review.",
    routing: "- for fixture tasks -> read the fixture doc",
    "tools-gates": "Read/Grep/Glob are free; everything else is gated.",
    io: "Handed: a tile. Returned: the artifact + evidence, or a decision card.",
    safety: "- stop on any interactive gate.",
    done: "The tile's outcome line is honest and the work is reviewable.",
  },
  modules: {
    "zone-set": { fronts: 1 },
    "gate-wall": { gated: ["deploy", "spend"], enforcement: "PreToolUse deny until cleared" },
    verification: { required: true, shape: "an independent refuter pass on the evidence" },
    comms: { asymmetry: "compose-once / request-never", cadence: "weekly call", register: "outcomes only" },
    deploy: { surface: "testv.example" },
    design: { gate: "the craft skill" },
  },
};

export function matchAssertion(output: string, a: PromptAssertion): boolean {
  // Fail closed on an invalid regex: a broken assertion must read as a miss,
  // never as a silent pass. Flags come from the explicit field (JS has no
  // inline (?i) -- calibration caught exactly that authoring mistake).
  const flags = a.flags ? `s${a.flags}` : "s";
  switch (a.type) {
    case "contains": return output.includes(a.value);
    case "not_contains": return !output.includes(a.value);
    case "regex": try { return new RegExp(a.value, flags).test(output); } catch { return false; }
    case "not_regex": try { return !new RegExp(a.value, flags).test(output); } catch { return false; }
  }
}

export function caseTrialPasses(output: string, c: PromptCase): boolean {
  return c.assertions.every((a) => matchAssertion(output, a));
}

/** Paired stats over per-case (candidate - baseline) deltas. */
export function pairedStats(deltas: readonly number[]): { mean: number; ci95: number } {
  const n = deltas.length;
  if (n === 0) return { mean: 0, ci95: 0 };
  const mean = deltas.reduce((s, d) => s + d, 0) / n;
  if (n === 1) return { mean, ci95: Number.POSITIVE_INFINITY };
  const varSum = deltas.reduce((s, d) => s + (d - mean) * (d - mean), 0);
  const sd = Math.sqrt(varSum / (n - 1));
  return { mean, ci95: 1.96 * (sd / Math.sqrt(n)) };
}

/**
 * The verdict rule (the vector ship rule, prompt-design.md P7). Tolerances:
 * stat regression tolerance 0.05 (a candidate may not sit more than 5pp below
 * baseline at the CI bound); cost tolerance 1.5x (a prompt edit never silently
 * buys a 50% cost regression). INSUFFICIENT-n is a legitimate outcome: with a
 * dozen stat cases the suite resolves only ~large deltas, and saying so beats
 * inventing a verdict.
 */
export function decideVerdict(r: {
  floorTotal: number; floorPassedCandidate: number;
  statN: number; meanDelta: number; ci95: number;
  costBaselineUsd: number; costCandidateUsd: number; allowCost?: boolean;
}): PromptGateVerdict {
  if (r.floorPassedCandidate < r.floorTotal) return "NO-SHIP (floor)";
  if (r.statN === 0) return "SHIP-OK"; // floor-only suite: the floor IS the gate
  const lo = r.meanDelta - r.ci95;
  const hi = r.meanDelta + r.ci95;
  if (hi < 0) return "NO-SHIP (regression)";
  if (lo > -0.05) {
    if (!r.allowCost && r.costBaselineUsd > 0 && r.costCandidateUsd > r.costBaselineUsd * 1.5) return "NO-SHIP (cost)";
    return "SHIP-OK";
  }
  return "INSUFFICIENT-n";
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Load a prompt suite from <anchor>/.harness/evals/prompt/<name>.json. */
export function loadPromptSuite(anchor: string, name: string): PromptSuite {
  const path = join(anchor, ".harness", "evals", "prompt", `${name}.json`);
  const suite = JSON.parse(readFileSync(path, "utf8")) as PromptSuite;
  if (!suite.binds || !Array.isArray(suite.cases) || suite.cases.length === 0) {
    throw new Error(`suite ${name}: needs binds + non-empty cases`);
  }
  return suite;
}

/**
 * Render an artifact's text through the fixture when it is a template (contains
 * mustache slots); plain markdown passes through. A render that still carries
 * <UNRESOLVED:> means the fixture does not cover the template's slots -- that is
 * a gate ERROR (fix FIXTURE_CONTEXT or the suite's fixture block), never a
 * silent partial render.
 */
export function renderArm(raw: string, fixture?: Record<string, unknown>): string {
  if (!raw.includes("{{")) return raw;
  const ctx = { ...FIXTURE_CONTEXT, ...(fixture ?? {}) };
  const rendered = renderTemplate(raw, ctx);
  const unresolved = rendered.match(/<UNRESOLVED:[^>]+>/g);
  if (unresolved) throw new Error(`fixture does not cover template slots: ${[...new Set(unresolved)].join(", ")}`);
  return rendered;
}

/** The committed baseline of a repo file (git show HEAD:<rel>), or null when absent at HEAD. */
export function baselineContent(anchor: string, rel: string, ref = "HEAD"): string | null {
  const r = spawnSync("git", ["-C", anchor, "show", `${ref}:${rel}`], { encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Compose the subject prompt. The leading header line is load-bearing twice:
 * it frames the artifact as the operating contract, and it guarantees the
 * prompt never starts with "-" (a rendered pack opens with "---" frontmatter,
 * which the headless CLI would otherwise parse as a flag -- calibration
 * caught that as runner exit 1 with empty output).
 */
const composeSubjectPrompt = (artifact: string, task: string): string =>
  `YOUR OPERATING CONTRACT (follow it when answering):\n\n${artifact}\n\n---\n\nTASK:\n${task}`;

const defaultRunner: SubjectRunner = async (composed, tier) => {
  const resolved = tierEnv(tier);
  if (resolved.missing && resolved.missing.length > 0) {
    return { text: `tier ${tier} HELD (${resolved.missing.join(", ")})`, inTokens: 0, outTokens: 0, costUsd: 0, exit: 2 };
  }
  const entry = KERNEL_TIER_REGISTRY[tier];
  // Native anthropic tiers carry the CLI model alias in the registry; external
  // tiers carry it in the resolved env (ANTHROPIC_MODEL).
  const model = resolved.env?.ANTHROPIC_MODEL ?? entry?.model;
  return measuredClaudeRun(composed, { ...process.env, ...(resolved.env ?? {}) }, entry?.price, model);
};

export interface PromptGateOptions {
  readonly runner?: SubjectRunner;
  /** Run the candidate arm even when it matches HEAD (suite calibration). */
  readonly calibrate?: boolean;
  readonly allowCost?: boolean;
  readonly baselineRef?: string;
  /** Override the suite's trials (e.g. 1 for a cheap calibration sweep). */
  readonly trials?: number;
}

export async function runPromptGate(anchor: string, suiteName: string, opts: PromptGateOptions = {}): Promise<PromptGateReport> {
  const suite = loadPromptSuite(anchor, suiteName);
  const tier = suite.tier ?? "scoped";
  const trials = opts.trials ?? suite.trials ?? 3;
  const runner = opts.runner ?? defaultRunner;
  const notes: string[] = [];

  const candidateRaw = readFileSync(join(anchor, suite.binds), "utf8");
  const candidate = renderArm(candidateRaw, suite.fixture);
  const artifactHash = sha256(candidate);

  const baseRaw = baselineContent(anchor, suite.binds, opts.baselineRef ?? "HEAD");
  const calibrating = opts.calibrate === true || baseRaw === null;
  if (baseRaw === null) notes.push(`no baseline at ${opts.baselineRef ?? "HEAD"}:${suite.binds} -- calibration run (candidate arm only)`);
  const baseline = calibrating ? null : renderArm(baseRaw as string, suite.fixture);

  if (!calibrating && baseline === candidate) {
    return {
      suite: suite.suite, version: suite.version, binds: suite.binds, artifactHash, tier, trials,
      cases: [], floorTotal: 0, floorPassedCandidate: 0, floorPassedBaseline: 0,
      statN: 0, meanDelta: 0, ci95: 0, resolvableDelta: 0,
      costBaselineUsd: 0, costCandidateUsd: 0, verdict: "NO-CHANGE",
      notes: [...notes, "artifact matches baseline byte-identically -- nothing to gate (use calibrate to run anyway)"],
    };
  }

  let costBase = 0;
  let costCand = 0;
  const results: CaseResult[] = [];
  for (const c of suite.cases) {
    // All trials of both arms run concurrently -- each is an independent
    // headless spawn, and the per-call latency (agent wrap) dominates wall
    // clock. Sequencing stays per-case so a runaway suite is interruptible.
    const jobs: Array<{ arm: "baseline" | "candidate"; t: number; run: Promise<MeasuredRun> }> = [];
    for (const { arm, text } of [
      { arm: "baseline" as const, text: baseline },
      { arm: "candidate" as const, text: candidate },
    ]) {
      if (text === null) continue; // calibration: no baseline arm
      for (let t = 0; t < trials; t++) jobs.push({ arm, t, run: runner(composeSubjectPrompt(text, c.task), tier) });
    }
    const runs = await Promise.all(jobs.map((j) => j.run));
    const scores: Record<"baseline" | "candidate", number> = { baseline: 0, candidate: 0 };
    const counts: Record<"baseline" | "candidate", number> = { baseline: 0, candidate: 0 };
    const failures: string[] = [];
    jobs.forEach((j, i) => {
      const run = runs[i];
      if (j.arm === "baseline") costBase += run.costUsd; else costCand += run.costUsd;
      counts[j.arm]++;
      if (run.exit !== 0) { failures.push(`${j.arm} t${j.t + 1}: runner exit ${run.exit}: ${run.text.slice(0, 60)}`); return; }
      if (caseTrialPasses(run.text, c)) scores[j.arm]++;
      else failures.push(`${j.arm} t${j.t + 1}: assertion miss: "${run.text.replace(/\s+/g, " ").trim().slice(0, 60)}"`);
    });
    results.push({
      id: c.id, class: c.class,
      baseline: counts.baseline > 0 ? scores.baseline / counts.baseline : 0,
      candidate: counts.candidate > 0 ? scores.candidate / counts.candidate : 0,
      detail: failures.length ? failures.slice(0, 3).join(" | ") : "clean",
    });
  }

  const floor = results.filter((r) => r.class === "floor");
  const stat = results.filter((r) => r.class === "stat");
  const floorPassedCandidate = floor.filter((r) => r.candidate === 1).length;
  const floorPassedBaseline = floor.filter((r) => r.baseline === 1).length;
  if (floorPassedBaseline < floor.length && !calibrating) {
    notes.push(`baseline already fails ${floor.length - floorPassedBaseline} floor case(s) -- pre-existing breach, candidate must still pass`);
  }
  const deltas = calibrating ? [] : stat.map((r) => r.candidate - r.baseline);
  const { mean, ci95 } = pairedStats(deltas);
  const resolvable = deltas.length > 1 ? ci95 : Number.POSITIVE_INFINITY;

  const verdict: PromptGateVerdict = calibrating
    ? "CALIBRATE"
    : decideVerdict({
        floorTotal: floor.length, floorPassedCandidate,
        statN: deltas.length, meanDelta: mean, ci95,
        costBaselineUsd: costBase, costCandidateUsd: costCand, allowCost: opts.allowCost,
      });

  if (verdict === "SHIP-OK") {
    recordGatePass(anchor, `prompt:${suite.suite}`, `prompt-gate ${artifactHash.slice(0, 8)}`);
  }
  if (verdict !== "NO-CHANGE") {
    const passedCount = floorPassedCandidate + stat.filter((r) => r.candidate >= r.baseline).length;
    appendEvalOutcome(anchor, { at: new Date().toISOString(), suite: `prompt:${suite.suite}`, passed: passedCount, total: results.length });
  }

  return {
    suite: suite.suite, version: suite.version, binds: suite.binds, artifactHash, tier, trials,
    cases: results, floorTotal: floor.length, floorPassedCandidate, floorPassedBaseline,
    statN: deltas.length, meanDelta: mean, ci95, resolvableDelta: resolvable,
    costBaselineUsd: costBase, costCandidateUsd: costCand, verdict, notes,
  };
}

export function formatPromptGateReport(r: PromptGateReport): string {
  const lines: string[] = [];
  lines.push(`harness prompt-gate: ${r.suite} v${r.version} -- binds ${r.binds}@${r.artifactHash.slice(0, 8)}  [tier ${r.tier}, ${r.cases.length} cases x ${r.trials} trials]`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (r.verdict === "NO-CHANGE") { lines.push(`  VERDICT: NO-CHANGE`); return lines.join("\n"); }
  if (r.floorTotal > 0) {
    const baseNote = r.verdict === "CALIBRATE" ? "baseline arm skipped" : `baseline ${r.floorPassedBaseline}/${r.floorTotal}`;
    lines.push(`  floor: candidate ${r.floorPassedCandidate}/${r.floorTotal} pass (${baseNote})`);
  }
  if (r.statN > 0) {
    const lo = (r.meanDelta - r.ci95).toFixed(3);
    const hi = (r.meanDelta + r.ci95).toFixed(3);
    lines.push(`  stat: mean delta ${r.meanDelta >= 0 ? "+" : ""}${r.meanDelta.toFixed(3)}  CI95 [${lo}, ${hi}]  n=${r.statN}`);
    if (Number.isFinite(r.resolvableDelta)) lines.push(`  power: this suite resolves only |delta| > ${r.resolvableDelta.toFixed(3)} -- smaller effects need more cases`);
  }
  if (r.costBaselineUsd > 0 || r.costCandidateUsd > 0) {
    const pct = r.costBaselineUsd > 0 ? ` (${(((r.costCandidateUsd - r.costBaselineUsd) / r.costBaselineUsd) * 100).toFixed(1)}%)` : "";
    lines.push(`  cost: baseline $${r.costBaselineUsd.toFixed(4)} -> candidate $${r.costCandidateUsd.toFixed(4)}${pct}`);
  }
  for (const c of r.cases.filter((x) => x.detail !== "clean")) lines.push(`  ${c.class} ${c.id}: base ${c.baseline.toFixed(2)} cand ${c.candidate.toFixed(2)} -- ${c.detail}`);
  lines.push(`  VERDICT: ${r.verdict}`);
  return lines.join("\n");
}
