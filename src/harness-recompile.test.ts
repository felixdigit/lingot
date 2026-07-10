import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvalOutcome } from "./harness-drift";
import { driftCycle, type AdoptFn } from "./harness-recompile";

const freshVenture = (): { anchor: string; manifestPath: string } => {
  const anchor = mkdtempSync(join(tmpdir(), "recompile-"));
  const manifestPath = join(anchor, "harness.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      harness: "harness/v1",
      identity: { name: "t", kind: "venture", owners: ["felix"] },
      kernel: { version: "~> 1" },
    }),
  );
  return { anchor, manifestPath };
};

const seedGates = (anchor: string, suite: string): void => {
  const dir = join(anchor, ".harness");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "gates.json"),
    JSON.stringify({
      [suite]: { passed: true, by: "harness eval" },
      [`tier_swap:${suite}:bulk`]: { passed: true, by: "proved 10/10" },
    }),
  );
};

const readGates = (anchor: string): any => JSON.parse(readFileSync(join(anchor, ".harness", "gates.json"), "utf8"));

const seedDecay = (anchor: string, suite: string): void => {
  for (const r of [1.0, 1.0, 1.0, 0.3, 0.2, 0.3]) {
    appendEvalOutcome(anchor, { at: "t", suite, passed: Math.round(r * 10), total: 10 });
  }
};

const readLedgerLines = (anchor: string): any[] =>
  readFileSync(join(anchor, ".harness", "recompiles.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

describe("driftCycle", () => {
  it("not drifted -- touches nothing: gates intact, no ledger line, adoptFn not called", async () => {
    const { anchor, manifestPath } = freshVenture();
    seedGates(anchor, "pong");
    const gatesBefore = readGates(anchor);
    const adoptFn = vi.fn<AdoptFn>();

    const report = await driftCycle(manifestPath, "pong", { adoptFn });

    expect(report).toEqual({ suite: "pong", drifted: false, revoked: [], recompiled: false, detail: report.detail });
    expect(report.detail).toMatch(/insufficient history/);
    expect(readGates(anchor)).toEqual(gatesBefore);
    expect(existsSync(join(anchor, ".harness", "recompiles.jsonl"))).toBe(false);
    expect(adoptFn).not.toHaveBeenCalled();
  });

  it("drifted -- revokes, calls adoptFn, appends the ledger line, reports verdictLevel", async () => {
    const { anchor, manifestPath } = freshVenture();
    seedGates(anchor, "pong");
    seedDecay(anchor, "pong");
    const adoptFn = vi.fn<AdoptFn>().mockReturnValue({ verdict: { level: "green" }, errors: [] });

    const report = await driftCycle(manifestPath, "pong", { adoptFn });

    expect(report.drifted).toBe(true);
    expect([...report.revoked].sort()).toEqual(["pong", "tier_swap:pong:bulk"].sort());
    expect(report.recompiled).toBe(true);
    expect(report.verdictLevel).toBe("green");
    expect(report.detail).toMatch(/revoked 2 gate\(s\)/);
    expect(report.detail).toMatch(/recompiled, verdict green/);

    expect(adoptFn).toHaveBeenCalledWith(manifestPath);
    const gates = readGates(anchor);
    expect(gates.pong).toEqual({ passed: false, note: "revoked: eval drift" });
    expect(gates["tier_swap:pong:bulk"]).toEqual({ passed: false, note: "revoked: eval drift" });

    const lines = readLedgerLines(anchor);
    expect(lines).toHaveLength(1);
    expect(lines[0].suite).toBe("pong");
    expect(lines[0].revoked.sort()).toEqual(["pong", "tier_swap:pong:bulk"].sort());
    expect(lines[0].verdictLevel).toBe("green");
    expect(typeof lines[0].at).toBe("string");
    expect(() => new Date(lines[0].at).toISOString()).not.toThrow();
  });

  it("adoptFn throwing -- revoked still done, recompiled false, ledger line still appended", async () => {
    const { anchor, manifestPath } = freshVenture();
    seedGates(anchor, "pong");
    seedDecay(anchor, "pong");
    const adoptFn = vi.fn<AdoptFn>().mockImplementation(() => {
      throw new Error("compile blew up");
    });

    const report = await driftCycle(manifestPath, "pong", { adoptFn });

    expect(report.drifted).toBe(true);
    expect([...report.revoked].sort()).toEqual(["pong", "tier_swap:pong:bulk"].sort());
    expect(report.recompiled).toBe(false);
    expect(report.verdictLevel).toBeUndefined();
    expect(report.detail).toMatch(/recompile threw: compile blew up/);

    const gates = readGates(anchor);
    expect(gates.pong).toEqual({ passed: false, note: "revoked: eval drift" });
    expect(gates["tier_swap:pong:bulk"]).toEqual({ passed: false, note: "revoked: eval drift" });

    const lines = readLedgerLines(anchor);
    expect(lines).toHaveLength(1);
    expect(lines[0].verdictLevel).toBeUndefined();
  });

  it("adoptFn returning errors -- recompile held, revoked still done, verdictLevel still reported if present", async () => {
    const { anchor, manifestPath } = freshVenture();
    seedGates(anchor, "pong");
    seedDecay(anchor, "pong");
    const adoptFn = vi.fn<AdoptFn>().mockReturnValue({ verdict: { level: "red" }, errors: ["held: promote gate(s) not passed"] });

    const report = await driftCycle(manifestPath, "pong", { adoptFn });

    expect(report.recompiled).toBe(false);
    expect(report.verdictLevel).toBe("red");
    expect(report.detail).toMatch(/recompile held: held: promote gate\(s\) not passed/);
    expect([...report.revoked].sort()).toEqual(["pong", "tier_swap:pong:bulk"].sort());
  });
});
