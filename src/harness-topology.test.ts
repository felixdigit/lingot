import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPool } from "./harness-topology";
import { runPlan } from "./harness-plan";
import type { LaborUnit, RouteResult } from "./harness-route";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("runPool", () => {
  it("preserves input order despite out-of-order completion", async () => {
    // Item 0 is the slowest, item 2 the fastest -- completion order is 2, 1, 0.
    const delays = [30, 15, 5];
    const results = await runPool(delays, (ms, i) => delay(ms, i), 3);
    expect(results).toEqual([
      { ok: true, value: 0 },
      { ok: true, value: 1 },
      { ok: true, value: 2 },
    ]);
  });

  it("never exceeds the concurrency cap on max in-flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const items = [10, 10, 10, 10, 10, 10, 10, 10];
    const worker = async (ms: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(ms, null);
      inFlight -= 1;
      return ms;
    };
    await runPool(items, worker, 3);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("isolates a rejecting worker without affecting the others", async () => {
    const items = [0, 1, 2, 3];
    const worker = async (i: number) => {
      if (i === 2) throw new Error("boom");
      return delay(5, i * 10);
    };
    const results = await runPool(items, worker, 4);
    expect(results).toEqual([
      { ok: true, value: 0 },
      { ok: true, value: 10 },
      { ok: false, error: "boom" },
      { ok: true, value: 30 },
    ]);
  });

  it("clamps concurrency 0 up to 1", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const items = [1, 2, 3];
    const worker = async (i: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5, i);
      inFlight -= 1;
      return i;
    };
    const results = await runPool(items, worker, 0);
    expect(maxInFlight).toBe(1);
    expect(results).toEqual([{ ok: true, value: 1 }, { ok: true, value: 2 }, { ok: true, value: 3 }]);
  });

  it("clamps concurrency above items.length down to items.length", async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const items = [1, 2, 3];
    const worker = async (i: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5, i);
      inFlight -= 1;
      return i;
    };
    const results = await runPool(items, worker, 100);
    expect(maxInFlight).toBe(3);
    expect(results).toHaveLength(3);
  });

  it("returns [] for empty items", async () => {
    const results = await runPool([], async () => 1, 5);
    expect(results).toEqual([]);
  });
});

function tmpPlanFile(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-topology-"));
  const path = join(dir, "plan.jsonl");
  writeFileSync(path, lines.join("\n"));
  return path;
}

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

describe("runPlan concurrency", () => {
  it("produces the same results/totals/order as concurrency:1, and a failing unit does not kill the run", async () => {
    const path = tmpPlanFile([
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
      '{"prompt": "b", "workType": "x", "check": "equals:y"}',
      '{"prompt": "c", "workType": "x", "check": "equals:y"}',
      '{"prompt": "d", "workType": "x", "check": "equals:y"}',
      '{"prompt": "e", "workType": "x", "check": "equals:y"}',
    ]);

    const outcomes: Record<string, { costUsd: number; exit: number }> = {
      a: { costUsd: 0.01, exit: 0 },
      b: { costUsd: 0.02, exit: 1 },
      c: { costUsd: 0.03, exit: 0 },
      d: { costUsd: 0.04, exit: 0 },
      e: { costUsd: 0.05, exit: 1 },
    };
    const delays: Record<string, number> = { a: 20, b: 5, c: 15, d: 1, e: 10 };

    const makeRoute = () => async (_manifest: string, unit: LaborUnit): Promise<RouteResult> => {
      await delay(delays[unit.prompt], null);
      return fakeResult(outcomes[unit.prompt]);
    };

    const sequential = await runPlan("manifest.json", path, { route: makeRoute(), concurrency: 1 });
    const pooled = await runPlan("manifest.json", path, { route: makeRoute(), concurrency: 3 });

    expect(pooled.results.map((r) => r.unit.prompt)).toEqual(sequential.results.map((r) => r.unit.prompt));
    expect(pooled.results.map((r) => ({ text: r.text, acceptedTier: r.acceptedTier, costUsd: r.costUsd, exit: r.exit }))).toEqual(
      sequential.results.map((r) => ({ text: r.text, acceptedTier: r.acceptedTier, costUsd: r.costUsd, exit: r.exit })),
    );
    expect(pooled.accepted).toBe(sequential.accepted);
    expect(pooled.failed).toBe(sequential.failed);
    expect(pooled.totalCostUsd).toBeCloseTo(sequential.totalCostUsd);
    expect(pooled.accepted).toBe(3);
    expect(pooled.failed).toBe(2);
  });

  it("records a pool-level rejection as a failed unit result and continues the run", async () => {
    const path = tmpPlanFile([
      '{"prompt": "a", "workType": "x", "check": "equals:y"}',
      '{"prompt": "b", "workType": "x", "check": "equals:y"}',
    ]);
    const route = async (_manifest: string, unit: LaborUnit): Promise<RouteResult> => {
      if (unit.prompt === "a") throw new Error("route exploded");
      return fakeResult({ costUsd: 0.01, exit: 0 });
    };
    const r = await runPlan("manifest.json", path, { route, concurrency: 2 });
    expect(r.results).toHaveLength(2);
    expect(r.results[0]).toMatchObject({ text: "ERR: route exploded", acceptedTier: "<none>", costUsd: 0, exit: 1 });
    expect(r.results[1].exit).toBe(0);
    expect(r.accepted).toBe(1);
    expect(r.failed).toBe(1);
  });
});
