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
  /** Token usage + estimated cost, when the dispatch was a measured claude run. */
  readonly inTokens?: number;
  readonly outTokens?: number;
  readonly costUsd?: number;
}

/** Estimated cost in USD from token counts + the tier's per-million price. */
export function estimateCostUsd(inTokens: number, outTokens: number, price?: { in: number; out: number }): number {
  if (!price) return 0;
  return (inTokens / 1e6) * price.in + (outTokens / 1e6) * price.out;
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
  readonly totalCostUsd: number;
  readonly costByTier: Readonly<Record<string, number>>;
}

export function summarizeUsage(records: readonly DispatchRecord[]): UsageSummary {
  const byTier: Record<string, number> = {};
  const costByTier: Record<string, number> = {};
  const byRole = { judgment: 0, labor: 0 };
  let totalCostUsd = 0;
  for (const r of records) {
    byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    const c = r.costUsd ?? 0;
    costByTier[r.tier] = (costByTier[r.tier] ?? 0) + c;
    totalCostUsd += c;
    if (r.role === "judgment") byRole.judgment += 1;
    else byRole.labor += 1;
  }
  return { total: records.length, byTier, byRole, totalCostUsd, costByTier };
}

const usd = (n: number): string => "$" + n.toFixed(n > 0 && n < 0.01 ? 5 : 4);

export function formatUsage(s: UsageSummary): string {
  if (s.total === 0) return "harness usage: no dispatches recorded yet";
  const lines = [`harness usage: ${s.total} dispatch(es), est. ${usd(s.totalCostUsd)} total`];
  for (const [tier, n] of Object.entries(s.byTier).sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${String(n).padStart(4)}  ${tier.padEnd(12)} est. ${usd(s.costByTier[tier] ?? 0)}`);
  }
  const pctLabor = Math.round((s.byRole.labor / s.total) * 100);
  lines.push(`  -- ${pctLabor}% labor / ${100 - pctLabor}% judgment (route labor down, keep judgment premium)`);
  return lines.join("\n");
}
