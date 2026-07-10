import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { readGateLedger, type GateLedger } from "./harness-gates";

/**
 * Recompile-on-drift (docs/harness/21 section 4, docs/harness/16 section 5): an
 * eval metric that decays over time is drift. Drift REVOKES trust -- the matching
 * gate-ledger entries flip to failed so the router/adopter stop relying on the
 * decayed proof until it is re-earned via `harness prove-tier` / `harness eval`.
 * Actually re-running compilation on drift is a later slice; this module only
 * detects the decay and revokes the stale gate(s).
 */

export interface EvalOutcome {
  readonly at: string;
  readonly suite: string;
  readonly tier?: string;
  readonly passed: number;
  readonly total: number;
}

const historyPath = (anchor: string): string => join(anchor, ".harness", "eval-history.jsonl");

/** Append one outcome line. Best-effort -- eval history is a signal, not a source of truth; never throws. */
export function appendEvalOutcome(anchor: string, o: EvalOutcome): void {
  try {
    const p = historyPath(anchor);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(o) + "\n");
  } catch {
    // best-effort -- never throws
  }
}

/**
 * All recorded outcomes for `suite`, oldest first. [] when the history file is
 * absent. Malformed lines are SKIPPED individually -- one corrupt line must not
 * silently erase the whole history (a drift signal built on [] would never fire).
 */
export function readEvalHistory(anchor: string, suite: string): EvalOutcome[] {
  let raw: string;
  try {
    raw = readFileSync(historyPath(anchor), "utf8");
  } catch {
    return [];
  }
  const out: EvalOutcome[] = [];
  for (const l of raw.split("\n")) {
    const s = l.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as EvalOutcome;
      if (o.suite === suite) out.push(o);
    } catch {
      /* skip the corrupt line, keep the rest */
    }
  }
  return out;
}

/** Every distinct suite name in the venture's eval history (for the --all sweep). Corrupt lines skipped. */
export function readEvalSuites(anchor: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(historyPath(anchor), "utf8");
  } catch {
    return [];
  }
  const suites = new Set<string>();
  for (const l of raw.split("\n")) {
    const s = l.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s) as EvalOutcome;
      if (o.suite) suites.add(o.suite);
    } catch {
      /* skip */
    }
  }
  return [...suites].sort();
}

export interface DriftReport {
  readonly suite: string;
  readonly drifted: boolean;
  readonly baselineRate: number;
  readonly recentRate: number;
  readonly window: number;
  readonly detail: string;
}

const passRate = (o: EvalOutcome): number => (o.total > 0 ? o.passed / o.total : 0);
const mean = (xs: number[]): number => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * baselineRate = mean pass-rate of everything before the trailing `window`;
 * recentRate = mean pass-rate of the trailing `window`. Drifted when there is
 * enough history to have a baseline (>= window + 1 outcomes) AND the recent
 * rate has dropped at least `drop` below baseline. Fewer outcomes -> not
 * drifted (honest: no signal, not a false negative).
 */
export function detectDrift(anchor: string, suite: string, opts?: { window?: number; drop?: number }): DriftReport {
  const window = opts?.window ?? 3;
  const drop = opts?.drop ?? 0.2;
  const history = readEvalHistory(anchor, suite);
  if (history.length < window + 1) {
    return {
      suite,
      drifted: false,
      baselineRate: 0,
      recentRate: 0,
      window,
      detail: `insufficient history (${history.length} < ${window + 1}) -- no signal`,
    };
  }
  const recent = history.slice(-window);
  const baseline = history.slice(0, history.length - window);
  const baselineRate = mean(baseline.map(passRate));
  const recentRate = mean(recent.map(passRate));
  const drifted = recentRate <= baselineRate - drop;
  const detail = drifted
    ? `drift: recent ${recentRate.toFixed(2)} <= baseline ${baselineRate.toFixed(2)} - ${drop}`
    : `no drift: recent ${recentRate.toFixed(2)} vs baseline ${baselineRate.toFixed(2)} (drop ${drop})`;
  return { suite, drifted, baselineRate, recentRate, window, detail };
}

const gateLedgerPath = (anchor: string): string => join(anchor, ".harness", "gates.json");

/**
 * Flip every gate-ledger key proven BY `suite` (the suite itself, or any
 * `tier_swap:<suite>:<tier>` proof) to failed with a drift note. Mirrors the
 * read/write pattern in harness-gates.ts's recordGatePass -- kept local so
 * harness-gates.ts stays untouched. Returns the revoked keys.
 */
export function recordGateRevoke(anchor: string, suite: string, note: string): string[] {
  const ledger: GateLedger = readGateLedger(anchor);
  const prefix = `tier_swap:${suite}:`;
  const revoked = Object.keys(ledger).filter((k) => k === suite || k.startsWith(prefix));
  if (revoked.length === 0) return [];
  for (const k of revoked) {
    ledger[k] = { passed: false, note };
  }
  const p = gateLedgerPath(anchor);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n");
  return revoked;
}

/** Not drifted -> no-op, []. Drifted -> revoke the matching gate(s), return the revoked keys. */
export function respondToDrift(anchor: string, suite: string, report: DriftReport): string[] {
  if (!report.drifted) return [];
  return recordGateRevoke(anchor, suite, "revoked: eval drift");
}
