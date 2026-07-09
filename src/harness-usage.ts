import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";

/**
 * The dispatch ledger (docs/harness/15 -- observability, first slice). Every
 * `harness run` appends a record so the tier distribution is visible: is labor
 * actually going to the cheap tiers vs premium? This is step one toward
 * cost-per-accepted-change -- counts + tier now; token/cost enrichment (from
 * `claude --output-format json` or the gateway) is a follow-on. Runtime act
 * (not compile), so a timestamp is fine here.
 */

export interface DispatchRecord {
  readonly at: string; // ISO timestamp
  readonly tier: string;
  readonly provider: string;
  readonly model: string;
  readonly role: "judgment" | "labor";
  readonly exit: number;
}

const ledgerPath = (root: string): string => join(root, ".harness", "usage.jsonl");

/** Append a dispatch to the ledger under root (the cwd the run was launched from). */
export function recordDispatch(root: string, rec: DispatchRecord): void {
  const p = ledgerPath(root);
  try {
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch {
    /* ledger is best-effort -- never fail a dispatch over it */
  }
}

export function readUsage(root: string): DispatchRecord[] {
  try {
    return readFileSync(ledgerPath(root), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DispatchRecord);
  } catch {
    return [];
  }
}

export interface UsageSummary {
  readonly total: number;
  readonly byTier: Readonly<Record<string, number>>;
  readonly byRole: { judgment: number; labor: number };
}

export function summarizeUsage(records: readonly DispatchRecord[]): UsageSummary {
  const byTier: Record<string, number> = {};
  const byRole = { judgment: 0, labor: 0 };
  for (const r of records) {
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    if (r.role === "judgment") byRole.judgment += 1;
    else byRole.labor += 1;
  }
  return { total: records.length, byTier, byRole };
}

export function formatUsage(s: UsageSummary): string {
  if (s.total === 0) return "harness usage: no dispatches recorded yet";
  const lines = [`harness usage: ${s.total} dispatch(es)`];
  for (const [tier, n] of Object.entries(s.byTier).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(4)}  ${tier}`);
  }
  const pctLabor = Math.round((s.byRole.labor / s.total) * 100);
  lines.push(`  -- ${pctLabor}% labor / ${100 - pctLabor}% judgment (route labor down, keep judgment premium)`);
  return lines.join("\n");
}
