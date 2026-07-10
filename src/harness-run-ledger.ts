import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The run-ledger (Order J, extends Order I's emit layer). Join key = the Slack
 * message `ts`. The emit layer appends one line per ACTIONABLE post (dispatch,
 * gate-held, failure); the Socket Mode listener reads it back to map a reaction
 * or reply on that `ts` to the run it belongs to. The post stays human-readable
 * -- the machine detail (which run, which op) lives here, never in the message.
 * Append-only, cap/rotate is a later concern. Never throws.
 */

export interface RunLedgerEntry {
  readonly ts: string;
  readonly channel: string;
  readonly kind: string;
  /** The venture dir/manifest target for re-dispatch: `harness exec <dir> ...`. */
  readonly dir: string;
  readonly task: string;
  readonly heldOps: readonly string[];
  readonly venture: string;
}

const LEDGER_REL = ".harness/run-ledger.jsonl";

function ledgerPath(anchor: string): string {
  return join(anchor, LEDGER_REL);
}

/** Append one ledger entry. Best-effort -- a ledger write failure never blocks the emit path. */
export function appendLedger(anchor: string, entry: RunLedgerEntry): void {
  try {
    const path = ledgerPath(anchor);
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, JSON.stringify(entry) + "\n");
  } catch {
    // best-effort, see module doc.
  }
}

/** Read the entry keyed by `ts`, or null if none (missing ledger, missing key). Never throws. */
export function readLedger(anchor: string, ts: string): RunLedgerEntry | null {
  try {
    const path = ledgerPath(anchor);
    if (!existsSync(path)) return null;
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry && entry.ts === ts) return entry as RunLedgerEntry;
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
}
