import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPlan, runPlan, formatPlanResult } from "./harness-plan";
import type { LaborUnit, RouteResult } from "./harness-route";

function tmpPlanFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-plan-"));
  const path = join(dir, "plan.jsonl");
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("loader seams caught on review (Fable wiring pass)", () => {
  it("a typo'd check kind is a LOAD error, not a mid-run crash", () => {
    const path = tmpPlanFile(['{"prompt":"p","workType":"x","check":"equal:PONG"}']);
    const { units, errors } = loadPlan(path);
    expect(units).toHaveLength(0);
    expect(errors[0]).toMatch(/line 1: unknown check kind/);
  });
  it("a missing plan file is a loader error, never a throw", () => {
    const { units, errors } = loadPlan("/nonexistent/plan.jsonl");
    expect(units).toHaveLength(0);
    expect(errors[0]).toMatch(/cannot read plan/);
  });
});

function fakeResult(overrides: Partial<RouteResult> = {}): RouteResult {
  return {
    text: "ok",
    acceptedTier: "bulk",
    role: "labor",
    flooredByRole: false,
    proven: true,
    triedCheap: true,
    escalated: false,
    checkPassed: true,
    costUsd: 0.001,
    exit: 0,
    ...overrides,
  };
}

describe("loadPlan", () => {
  it("rejects a labor unit missing check, naming the line", () => {
    const path = tmpPlanFile(['{"prompt": "a", "workType": "classify"}']);
    const { units, errors } = loadPlan(path);
    expect(units).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 1/);
    expect(errors[0]).toMatch(/check/);
  });

  it("rejects a labor unit missing workType, naming the line", () => {
    const path = tmpPlanFile(['{"prompt": "a", "check": "equals:PONG"}']);
    const { units, errors } = loadPlan(path);
    expect(units).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 1/);
    expect(errors[0]).toMatch(/workType/);
  });

  it("does not require workType/check for a non-labor role", () => {
    const path = tmpPlanFile(['{"prompt": "review this diff", "role": "gate"}']);
    const { units, errors } = loadPlan(path);
    expect(errors).toHaveLength(0);
    expect(units).toHaveLength(1);
    expect(units[0].role).toBe("gate");
  });

  it("turns a malformed JSON line into an error, not a crash", () => {
    const path = tmpPlanFile([
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
      "{not json",
      '{"prompt": "b", "workType": "x", "check": "equals:z"}',
    ]);
    const { units, errors } = loadPlan(path);
    expect(units).toHaveLength(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/line 2/);
  });

  it("skips blank lines and comments", () => {
    const path = tmpPlanFile([
      "# a comment",
      "",
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
    ]);
    const { units, errors } = loadPlan(path);
    expect(units).toHaveLength(1);
    expect(errors).toHaveLength(0);
  });
});

describe("runPlan", () => {
  it("runs a mixed plan sequentially and aggregates cost/accepted/failed", async () => {
    const path = tmpPlanFile([
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
      '{"prompt": "b", "role": "gate"}',
    ]);
    const order: string[] = [];
    const route = async (_manifest: string, unit: LaborUnit): Promise<RouteResult> => {
      order.push(unit.prompt);
      return fakeResult({ costUsd: 0.01, exit: 0 });
    };
    const r = await runPlan("manifest.json", path, { route });
    expect(order).toEqual(["a", "b"]);
    expect(r.results).toHaveLength(2);
    expect(r.accepted).toBe(2);
    expect(r.failed).toBe(0);
    expect(r.totalCostUsd).toBeCloseTo(0.02);
  });

  it("does not stop the plan when a unit fails", async () => {
    const path = tmpPlanFile([
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
      '{"prompt": "b", "workType": "x", "check": "equals:y"}',
    ]);
    let calls = 0;
    const route = async (): Promise<RouteResult> => {
      calls += 1;
      return fakeResult({ exit: calls === 1 ? 1 : 0, costUsd: 0.005 });
    };
    const r = await runPlan("manifest.json", path, { route });
    expect(calls).toBe(2);
    expect(r.results).toHaveLength(2);
    expect(r.accepted).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.results[0].exit).toBe(1);
    expect(r.results[1].exit).toBe(0);
  });

  it("returns zero totals for an empty plan", async () => {
    const path = tmpPlanFile(["", "# nothing here"]);
    const route = async (): Promise<RouteResult> => fakeResult();
    const r = await runPlan("manifest.json", path, { route });
    expect(r.results).toHaveLength(0);
    expect(r.errors).toHaveLength(0);
    expect(r.totalCostUsd).toBe(0);
    expect(r.accepted).toBe(0);
    expect(r.failed).toBe(0);
  });

  it("short-circuits on loader errors without ever calling route", async () => {
    const path = tmpPlanFile(['{"prompt": "a"}']);
    let called = false;
    const route = async (): Promise<RouteResult> => {
      called = true;
      return fakeResult();
    };
    const r = await runPlan("manifest.json", path, { route });
    expect(called).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.results).toHaveLength(0);
    expect(r.accepted).toBe(0);
    expect(r.totalCostUsd).toBe(0);
  });
});

describe("formatPlanResult", () => {
  it("includes a per-unit line and cost-per-accepted totals", async () => {
    const path = tmpPlanFile(['{"prompt": "a", "workType": "x", "check": "equals:y"}']);
    const route = async (): Promise<RouteResult> => fakeResult({ costUsd: 0.02, exit: 0, acceptedTier: "bulk" });
    const r = await runPlan("manifest.json", path, { route });
    const out = formatPlanResult(r);
    expect(out).toMatch(/bulk/);
    expect(out).toMatch(/0\.02000/);
    expect(out).toMatch(/1 accepted/);
  });

  it("reports zero cost-per-accepted when nothing accepted", () => {
    const r = { results: [], errors: [], totalCostUsd: 0, accepted: 0, failed: 0 };
    const out = formatPlanResult(r);
    expect(out).toMatch(/cost\/accepted: \$0\.00000/);
  });

  it("surfaces loader errors instead of a unit summary", () => {
    const r = { results: [], errors: ["line 3: malformed JSON: boom"], totalCostUsd: 0, accepted: 0, failed: 0 };
    const out = formatPlanResult(r);
    expect(out).toMatch(/loader error/);
    expect(out).toMatch(/line 3/);
  });
});
