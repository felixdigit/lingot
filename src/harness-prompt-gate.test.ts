import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_CONTEXT,
  caseTrialPasses,
  decideVerdict,
  formatPromptGateReport,
  matchAssertion,
  pairedStats,
  renderArm,
  runPromptGate,
  type PromptSuite,
  type SubjectRunner,
} from "./harness-prompt-gate";

/** A git repo fixture with one committed artifact + one prompt suite. */
function gateFixture(opts: {
  committed: string;
  working?: string;
  cases?: PromptSuite["cases"];
  trials?: number;
}): { anchor: string } {
  const anchor = mkdtempSync(join(tmpdir(), "prompt-gate-"));
  execSync("git init -q && git config user.email t@t && git config user.name t", { cwd: anchor });
  writeFileSync(join(anchor, "artifact.md"), opts.committed);
  execSync("git add artifact.md && git commit -qm base", { cwd: anchor });
  if (opts.working !== undefined) writeFileSync(join(anchor, "artifact.md"), opts.working);
  const dir = join(anchor, ".harness", "evals", "prompt");
  mkdirSync(dir, { recursive: true });
  const suite: PromptSuite = {
    suite: "t", version: 1, binds: "artifact.md", trials: opts.trials ?? 1,
    cases: opts.cases ?? [
      { id: "f1", class: "floor", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
      { id: "s1", class: "stat", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
      { id: "s2", class: "stat", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
      { id: "s3", class: "stat", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
      { id: "s4", class: "stat", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
      { id: "s5", class: "stat", task: "answer", assertions: [{ type: "contains", value: "OK" }] },
    ],
  };
  writeFileSync(join(dir, "t.json"), JSON.stringify(suite));
  return { anchor };
}

/** A runner that answers "OK" only for the arm whose text contains the marker. */
const markerRunner = (marker: string): SubjectRunner => async (composed) => ({
  text: composed.includes(marker) ? "OK" : "MISS",
  inTokens: 10, outTokens: 5, costUsd: 0.001, exit: 0,
});

describe("assertions and scoring", () => {
  it("matches all four assertion types", () => {
    expect(matchAssertion("hello world", { type: "contains", value: "world" })).toBe(true);
    expect(matchAssertion("hello world", { type: "not_contains", value: "mars" })).toBe(true);
    expect(matchAssertion("Answer: NO.", { type: "regex", value: "\\bNO\\b" })).toBe(true);
    expect(matchAssertion("Answer: NO.", { type: "not_regex", value: "\\bYES\\b" })).toBe(true);
    expect(matchAssertion("x", { type: "regex", value: "(" })).toBe(false); // invalid regex fails closed
  });

  it("case-insensitive matching uses the flags field, never inline (?i)", () => {
    expect(matchAssertion("Review", { type: "regex", value: "\\breview\\b", flags: "i" })).toBe(true);
    // Inline (?i) is PCRE, not JS: it must fail closed, not silently pass.
    expect(matchAssertion("review", { type: "regex", value: "(?i)review" })).toBe(false);
  });

  it("a case trial passes only when every assertion holds", () => {
    const c = { id: "c", class: "floor" as const, task: "t", assertions: [
      { type: "contains" as const, value: "NO" },
      { type: "not_contains" as const, value: "YES" },
    ] };
    expect(caseTrialPasses("NO.", c)).toBe(true);
    expect(caseTrialPasses("NO but YES", c)).toBe(false);
  });

  it("paired stats: mean, CI, and the degenerate n cases", () => {
    expect(pairedStats([]).mean).toBe(0);
    expect(pairedStats([0.5]).ci95).toBe(Number.POSITIVE_INFINITY);
    const { mean, ci95 } = pairedStats([0.1, 0.1, 0.1, 0.1]);
    expect(mean).toBeCloseTo(0.1);
    expect(ci95).toBeCloseTo(0); // identical deltas: zero variance
  });
});

describe("the verdict rule (vector ship rule)", () => {
  const base = { floorTotal: 2, floorPassedCandidate: 2, statN: 6, meanDelta: 0.1, ci95: 0.05, costBaselineUsd: 0.01, costCandidateUsd: 0.01 };
  it("floor failure is NO-SHIP regardless of stats", () => {
    expect(decideVerdict({ ...base, floorPassedCandidate: 1, meanDelta: 0.9 })).toBe("NO-SHIP (floor)");
  });
  it("CI fully below zero is a regression", () => {
    expect(decideVerdict({ ...base, meanDelta: -0.2, ci95: 0.1 })).toBe("NO-SHIP (regression)");
  });
  it("CI clear of the tolerance ships", () => {
    expect(decideVerdict(base)).toBe("SHIP-OK");
  });
  it("wide CI spanning the tolerance is INSUFFICIENT-n, never a fake verdict", () => {
    expect(decideVerdict({ ...base, meanDelta: 0.05, ci95: 0.4 })).toBe("INSUFFICIENT-n");
  });
  it("a cost blowout blocks an otherwise-green ship unless allowed", () => {
    expect(decideVerdict({ ...base, costCandidateUsd: 0.02 })).toBe("NO-SHIP (cost)");
    expect(decideVerdict({ ...base, costCandidateUsd: 0.02, allowCost: true })).toBe("SHIP-OK");
  });
  it("a floor-only suite ships on its floor", () => {
    expect(decideVerdict({ ...base, statN: 0 })).toBe("SHIP-OK");
  });
});

describe("rendering arms", () => {
  it("plain markdown passes through untouched", () => {
    expect(renderArm("# plain\nno slots")).toBe("# plain\nno slots");
  });
  it("templates render through the fixture with no unresolved slots", () => {
    const out = renderArm("Venture {{name}}, founder {{founder}}, wall: {{gateWallList}}.");
    expect(out).toBe("Venture testv, founder Felix, wall: deploy, spend.");
  });
  it("a slot the fixture misses is a loud error, never a partial render", () => {
    expect(() => renderArm("{{no.such.slot}}")).toThrow(/does not cover/);
  });
  it("the shipped fixture covers the real kernel templates end to end", () => {
    // The load-bearing check: every {{slot}} in the live kernel templates
    // resolves through FIXTURE_CONTEXT, so the gate can bind any of them.
    const kernel = join(__dirname, "..", "kernel");
    for (const f of ["contract-base.md", "pack-template.md", "boot-skill.md"]) {
      const raw = require("node:fs").readFileSync(join(kernel, f), "utf8");
      expect(() => renderArm(raw), f).not.toThrow();
    }
    expect(FIXTURE_CONTEXT.name).toBe("testv");
  });
});

describe("runPromptGate end to end (stub runner)", () => {
  it("NO-CHANGE when the working tree matches HEAD", async () => {
    const { anchor } = gateFixture({ committed: "SAME" });
    const r = await runPromptGate(anchor, "t", { runner: markerRunner("never") });
    expect(r.verdict).toBe("NO-CHANGE");
  });

  it("an edit that makes cases pass ships; the report carries the paired stats", async () => {
    const { anchor } = gateFixture({ committed: "OLD text", working: "NEW text" });
    const r = await runPromptGate(anchor, "t", { runner: markerRunner("NEW") });
    expect(r.floorPassedCandidate).toBe(1);
    expect(r.floorPassedBaseline).toBe(0); // pre-existing breach flagged, candidate still gated
    expect(r.statN).toBe(5);
    expect(r.meanDelta).toBeCloseTo(1);
    expect(r.verdict).toBe("SHIP-OK");
    const text = formatPromptGateReport(r);
    expect(text).toContain("VERDICT: SHIP-OK");
    expect(text).toContain("floor: candidate 1/1");
  });

  it("an edit that breaks a floor case is NO-SHIP (floor)", async () => {
    const { anchor } = gateFixture({ committed: "GOOD text", working: "BAD text" });
    const r = await runPromptGate(anchor, "t", { runner: markerRunner("GOOD") });
    expect(r.verdict).toBe("NO-SHIP (floor)");
  });

  it("calibrate runs the candidate arm only and never ships", async () => {
    const { anchor } = gateFixture({ committed: "SAME" });
    const r = await runPromptGate(anchor, "t", { runner: markerRunner("SAME"), calibrate: true });
    expect(r.verdict).toBe("CALIBRATE");
    expect(r.cases.every((c) => c.baseline === 0)).toBe(true); // baseline arm skipped
    expect(r.cases.every((c) => c.candidate === 1)).toBe(true);
  });

  it("the composed subject prompt never starts with a dash (CLI flag hazard)", async () => {
    const seen: string[] = [];
    const spy: SubjectRunner = async (composed) => { seen.push(composed); return { text: "OK", inTokens: 1, outTokens: 1, costUsd: 0, exit: 0 }; };
    const { anchor } = gateFixture({ committed: "---\nname: pack\n---\nbody" });
    await runPromptGate(anchor, "t", { runner: spy, calibrate: true, trials: 1 });
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s.startsWith("-")).toBe(false);
  });

  it("the trials override wins over the suite's trials", async () => {
    let calls = 0;
    const counting: SubjectRunner = async () => { calls++; return { text: "OK", inTokens: 1, outTokens: 1, costUsd: 0, exit: 0 }; };
    const { anchor } = gateFixture({ committed: "SAME", trials: 3 });
    await runPromptGate(anchor, "t", { runner: counting, calibrate: true, trials: 1 });
    expect(calls).toBe(6); // 6 cases x 1 trial x 1 arm
  });

  it("runner failures surface in the case detail, not as silent passes", async () => {
    const failing: SubjectRunner = async () => ({ text: "boom", inTokens: 0, outTokens: 0, costUsd: 0, exit: 1 });
    const { anchor } = gateFixture({ committed: "OLD", working: "NEW" });
    const r = await runPromptGate(anchor, "t", { runner: failing });
    expect(r.verdict).toBe("NO-SHIP (floor)");
    expect(r.cases[0].detail).toContain("runner exit 1");
  });
});
