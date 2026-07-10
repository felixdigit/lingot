import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvalOutcome, readEvalHistory, detectDrift, respondToDrift, recordGateRevoke } from "./harness-drift";

const freshAnchor = (): string => mkdtempSync(join(tmpdir(), "drift-"));

const seed = (anchor: string, suite: string, rates: number[]): void => {
  for (const r of rates) appendEvalOutcome(anchor, { at: "t", suite, passed: Math.round(r * 10), total: 10 });
};

describe("appendEvalOutcome / readEvalHistory (eval-history.jsonl round-trip)", () => {
  it("appends one line per outcome, reads back in order, scoped to the suite", () => {
    const anchor = freshAnchor();
    appendEvalOutcome(anchor, { at: "1", suite: "a", passed: 10, total: 10 });
    appendEvalOutcome(anchor, { at: "2", suite: "b", passed: 5, total: 10 });
    appendEvalOutcome(anchor, { at: "3", suite: "a", passed: 8, total: 10 });
    expect(readEvalHistory(anchor, "a")).toEqual([
      { at: "1", suite: "a", passed: 10, total: 10 },
      { at: "3", suite: "a", passed: 8, total: 10 },
    ]);
    expect(readEvalHistory(anchor, "b")).toEqual([{ at: "2", suite: "b", passed: 5, total: 10 }]);
  });
  it("readEvalHistory returns [] when the history file is absent; append never throws", () => {
    const anchor = freshAnchor();
    expect(readEvalHistory(anchor, "nope")).toEqual([]);
    expect(() => appendEvalOutcome("/nonexistent/root/that/cannot/be/created\0bad", { at: "t", suite: "x", passed: 1, total: 1 })).not.toThrow();
  });
});

describe("detectDrift", () => {
  it("insufficient history (< window + 1 outcomes) -> not drifted, honest no-signal", () => {
    const anchor = freshAnchor();
    seed(anchor, "s", [1.0, 1.0, 1.0]); // window default 3 needs 4+
    const report = detectDrift(anchor, "s");
    expect(report.drifted).toBe(false);
    expect(report.baselineRate).toBe(0);
    expect(report.recentRate).toBe(0);
    expect(report.detail).toMatch(/insufficient history/);
  });
  it("fires on a clear decay: baseline 1.0,1.0,1.0 then recent 0.5,0.4,0.5", () => {
    const anchor = freshAnchor();
    seed(anchor, "s", [1.0, 1.0, 1.0, 0.5, 0.4, 0.5]);
    const report = detectDrift(anchor, "s");
    expect(report.window).toBe(3);
    expect(report.baselineRate).toBeCloseTo(1.0, 6);
    expect(report.recentRate).toBeCloseTo(0.4667, 3);
    expect(report.drifted).toBe(true);
    expect(report.detail).toMatch(/^drift:/);
  });
  it("stable rates -> not drifted", () => {
    const anchor = freshAnchor();
    seed(anchor, "s", [1.0, 1.0, 1.0, 0.9, 1.0, 0.9]);
    const report = detectDrift(anchor, "s");
    expect(report.drifted).toBe(false);
    expect(report.detail).toMatch(/^no drift:/);
  });
});

describe("respondToDrift / recordGateRevoke (gate ledger revocation)", () => {
  const seedLedger = (anchor: string, ledger: object): void => {
    const dir = join(anchor, ".harness");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "gates.json"), JSON.stringify(ledger));
  };
  const readLedger = (anchor: string): any => JSON.parse(readFileSync(join(anchor, ".harness", "gates.json"), "utf8"));

  it("drifted -> flips the suite key and every tier_swap:<suite>:* key, leaves other suites untouched", () => {
    const anchor = freshAnchor();
    seedLedger(anchor, {
      pong: { passed: true, by: "harness eval" },
      "tier_swap:pong:bulk": { passed: true, by: "proved 10/10" },
      "tier_swap:pong:reason": { passed: true, by: "proved 10/10" },
      "tier_swap:other:bulk": { passed: true, by: "proved 10/10" },
      unrelated: { passed: true },
    });
    seed(anchor, "pong", [1.0, 1.0, 1.0, 0.5, 0.4, 0.5]);
    const report = detectDrift(anchor, "pong");
    expect(report.drifted).toBe(true);
    const revoked = respondToDrift(anchor, "pong", report);
    expect(revoked.sort()).toEqual(["pong", "tier_swap:pong:bulk", "tier_swap:pong:reason"].sort());
    const ledger = readLedger(anchor);
    expect(ledger.pong).toEqual({ passed: false, note: "revoked: eval drift" });
    expect(ledger["tier_swap:pong:bulk"]).toEqual({ passed: false, note: "revoked: eval drift" });
    expect(ledger["tier_swap:pong:reason"]).toEqual({ passed: false, note: "revoked: eval drift" });
    expect(ledger["tier_swap:other:bulk"]).toEqual({ passed: true, by: "proved 10/10" });
    expect(ledger.unrelated).toEqual({ passed: true });
  });

  it("not drifted -> respondToDrift returns [] and writes nothing", () => {
    const anchor = freshAnchor();
    seedLedger(anchor, { pong: { passed: true, by: "harness eval" } });
    const before = readLedger(anchor);
    const report = { suite: "pong", drifted: false, baselineRate: 1, recentRate: 1, window: 3, detail: "no drift" };
    expect(respondToDrift(anchor, "pong", report)).toEqual([]);
    expect(readLedger(anchor)).toEqual(before);
  });

  it("recordGateRevoke with no matching keys returns [] and leaves the ledger untouched", () => {
    const anchor = freshAnchor();
    seedLedger(anchor, { "tier_swap:other:bulk": { passed: true } });
    const before = readLedger(anchor);
    expect(recordGateRevoke(anchor, "pong", "revoked: eval drift")).toEqual([]);
    expect(readLedger(anchor)).toEqual(before);
  });
});
