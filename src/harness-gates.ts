import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { HarnessManifest } from "./harness-manifest";

/**
 * Eval-gate enforcement (Phase 3 core, docs/harness/16 + A9): "no promotion
 * without passing the gate." The manifest declares evaluation.gates.promote =
 * the eval suites that must pass before any artifact goes live. A gate is
 * "passed" when a pass is recorded in the project's gate ledger
 * (.harness/gates.json). The adopter refuses to materialize while a declared
 * promote-gate is unmet -- the artifact is not-adoptable (docs/harness/05).
 *
 * The eval RUNNER (computing pass/fail from traces) is a later slice; this is
 * the GATE mechanism it plugs into. A pass is recorded by the runner, by CI, or
 * (break-glass) by the operator via `harness gate-pass`.
 */

export interface GateRecord {
  readonly passed: boolean;
  readonly by?: string;
  readonly note?: string;
}

export type GateLedger = Record<string, GateRecord>;

const ledgerPath = (anchor: string): string => join(anchor, ".harness", "gates.json");

export function readGateLedger(anchor: string): GateLedger {
  try {
    return JSON.parse(readFileSync(ledgerPath(anchor), "utf8")) as GateLedger;
  } catch {
    return {};
  }
}

/** Record a gate suite as passed. Runtime act (runner/CI/operator), not compile. */
export function recordGatePass(anchor: string, suite: string, by?: string): void {
  const ledger = readGateLedger(anchor);
  ledger[suite] = { passed: true, by };
  const p = ledgerPath(anchor);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
}

/** Declared promote-gate suites that are NOT recorded-passed -- the block set. */
export function unmetPromoteGates(resolved: HarnessManifest, anchor: string): string[] {
  const gates = resolved.evaluation?.gates?.promote ?? [];
  if (gates.length === 0) return [];
  const ledger = readGateLedger(anchor);
  return gates.filter((s) => !ledger[s]?.passed);
}
