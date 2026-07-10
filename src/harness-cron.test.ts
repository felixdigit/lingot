import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fireEligible } from "./harness-cron";
import type { Automation } from "./harness-manifest";

const freshAnchor = (): string => mkdtempSync(join(tmpdir(), "cron-"));

const eligible: Automation["eligibility"] = {
  repeats: true,
  auto_reject: true,
  end_to_end: true,
  objective_done: true,
};

function automation(name: string, overrides: Partial<Automation> = {}): Automation {
  return { name, eligibility: eligible, run: "true", ...overrides };
}

describe("fireEligible", () => {
  it("fires an eligible+runnable automation and records exit 0", () => {
    const r = fireEligible(freshAnchor(), [automation("a", { run: "true" })]);
    expect(r.fired).toEqual([{ name: "a", exit: 0 }]);
    expect(r.skipped).toEqual([]);
  });

  it("records exit 1 for a failing run but keeps sweeping later automations", () => {
    const automations = [
      automation("fails", { run: "false" }),
      automation("succeeds", { run: "true" }),
    ];
    const r = fireEligible(freshAnchor(), automations);
    expect(r.fired).toEqual([
      { name: "fails", exit: 1 },
      { name: "succeeds", exit: 0 },
    ]);
    expect(r.skipped).toEqual([]);
  });

  it("skips an ineligible automation and names the missing boxes", () => {
    const a = automation("ineligible", {
      eligibility: { repeats: true, auto_reject: false, end_to_end: true, objective_done: false },
    });
    const r = fireEligible(freshAnchor(), [a]);
    expect(r.fired).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].name).toBe("ineligible");
    expect(r.skipped[0].reason).toContain("auto_reject");
    expect(r.skipped[0].reason).toContain("objective_done");
  });

  it("skips an eligible automation with no run command and names that reason", () => {
    const a: Automation = { name: "no-run", eligibility: eligible };
    const r = fireEligible(freshAnchor(), [a]);
    expect(r.fired).toEqual([]);
    expect(r.skipped).toEqual([{ name: "no-run", reason: "eligible but no run command" }]);
  });

  it("restricts the sweep to the `only` names given, preserving input order", () => {
    const automations = [automation("a"), automation("b"), automation("c")];
    const r = fireEligible(freshAnchor(), automations, { only: ["c", "a"] });
    expect(r.fired.map((f) => f.name)).toEqual(["a", "c"]);
  });
});
