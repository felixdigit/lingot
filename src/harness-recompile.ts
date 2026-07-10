import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { detectDrift, respondToDrift, readEvalSuites } from "./harness-drift";
import { adopt } from "./harness-adopt";

/**
 * Recompile-on-drift, second half (docs/harness/21 section 4): harness-drift.ts
 * detects decay and revokes the stale gate(s); this module closes the loop by
 * triggering a fresh compile so a new artifact version can supersede the old
 * one (the recompile is itself eval-gated at adopt time, A9 -- drift never
 * auto-adopts a broken artifact, it just re-earns the right to try).
 */

export interface DriftCycleReport {
  readonly suite: string;
  readonly drifted: boolean;
  readonly revoked: readonly string[];
  readonly recompiled: boolean;
  readonly verdictLevel?: string;
  readonly detail: string;
}

export type AdoptFn = (manifestPath: string) => { verdict: { level: string }; errors: readonly string[] };

const ledgerPath = (anchor: string): string => join(anchor, ".harness", "recompiles.jsonl");

/** Append one ledger line. Best-effort -- the recompile ledger is a signal, not a source of truth; never throws. */
function appendRecompileLine(anchor: string, line: { at: string; suite: string; revoked: readonly string[]; verdictLevel?: string }): void {
  try {
    const p = ledgerPath(anchor);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + "\n");
  } catch {
    // best-effort -- never throws
  }
}

/**
 * Detect drift for `suite`; not drifted touches nothing. Drifted: revoke the
 * stale gate(s), THEN recompile (revoke-then-recompile order -- a failed
 * recompile must never leave a revoked gate looking passed, so revocation
 * always happens first and is never undone by a recompile failure).
 */
export async function driftCycle(
  manifestPath: string,
  suite: string,
  opts?: { window?: number; drop?: number; adoptFn?: AdoptFn },
): Promise<DriftCycleReport> {
  const anchor = dirname(manifestPath);
  const report = detectDrift(anchor, suite, { window: opts?.window, drop: opts?.drop });

  if (!report.drifted) {
    return { suite, drifted: false, revoked: [], recompiled: false, detail: report.detail };
  }

  const revoked = respondToDrift(anchor, suite, report);

  let recompiled = false;
  let verdictLevel: string | undefined;
  let failureNote = "";
  try {
    const result = opts?.adoptFn ? opts.adoptFn(manifestPath) : adopt(manifestPath);
    verdictLevel = result.verdict?.level;
    if (result.errors.length > 0) {
      failureNote = ` -- recompile held: ${result.errors.join("; ")}`;
    } else {
      recompiled = true;
    }
  } catch (err) {
    failureNote = ` -- recompile threw: ${(err as Error).message}`;
  }

  appendRecompileLine(anchor, { at: new Date().toISOString(), suite, revoked, verdictLevel });

  const detail = `${report.detail} -- revoked ${revoked.length} gate(s)${
    recompiled ? ` -- recompiled, verdict ${verdictLevel}` : failureNote
  }`;

  return { suite, drifted: true, revoked, recompiled, verdictLevel, detail };
}

/**
 * The nightly sweep (the cron automation's body): run the drift cycle over EVERY
 * suite the venture's eval history knows. No suites -> honest no-op. This is what
 * `harness drift <p> --all --recompile` and the declared nightly automation run.
 */
export async function sweepDrift(
  manifestPath: string,
  opts?: { window?: number; drop?: number; adoptFn?: AdoptFn },
): Promise<DriftCycleReport[]> {
  const anchor = dirname(manifestPath);
  const suites = readEvalSuites(anchor);
  const reports: DriftCycleReport[] = [];
  for (const suite of suites) {
    reports.push(await driftCycle(manifestPath, suite, opts));
  }
  return reports;
}
