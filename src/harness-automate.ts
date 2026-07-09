import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { Automation } from "./harness-manifest";

/**
 * The learning-loop automations runner (Phase 6, docs/harness/21 -- L12). Honors
 * the 4-box eligibility gate (Kopadze): automate only when the task REPEATS,
 * something can AUTO-REJECT bad output, the agent does it END-TO-END, and "done"
 * is OBJECTIVE. All four true -> a loop (fireable). Miss a box -> a manual prompt
 * (report the downgrade; no silent breadth). A scheduler (cron/git-hook) invokes
 * `harness automate <project> --fire <name>`; this runner verifies eligibility,
 * runs the automation's `run` command, and records the outcome. Recompile-on-
 * drift (the other L12 half) is a follow-on.
 */

const BOXES = ["repeats", "auto_reject", "end_to_end", "objective_done"] as const;

export function missingBoxes(a: Automation): string[] {
  const e = a.eligibility ?? {};
  return BOXES.filter((b) => e[b] !== true);
}

export function isEligible(a: Automation): boolean {
  return missingBoxes(a).length === 0;
}

export interface AutomationStatus {
  readonly name: string;
  readonly eligible: boolean;
  readonly missing: readonly string[];
  /** eligible AND carries a run command. */
  readonly runnable: boolean;
}

export function statusOf(a: Automation): AutomationStatus {
  const missing = missingBoxes(a);
  const eligible = missing.length === 0;
  return { name: a.name, eligible, missing, runnable: eligible && !!a.run };
}

export function formatAutomations(items: readonly Automation[]): string {
  if (!items.length) return "harness automate: no automations declared";
  const lines = [`harness automate: ${items.length} automation(s)`];
  for (const a of items) {
    const s = statusOf(a);
    lines.push(
      s.eligible
        ? `  loop    ${a.name}${a.run ? "" : "  (eligible but no run command)"}`
        : `  manual  ${a.name}  (missing: ${s.missing.join(", ")})`,
    );
  }
  return lines.join("\n");
}

export interface FireResult {
  readonly name: string;
  readonly fired: boolean;
  readonly exit?: number;
  readonly reason?: string;
}

/** Fire an eligible automation's `run` from the anchor; record the outcome. Refuses ineligible ones. */
export function fireAutomation(anchor: string, a: Automation): FireResult {
  const s = statusOf(a);
  if (!s.eligible) return { name: a.name, fired: false, reason: `not eligible (missing: ${s.missing.join(", ")}) -- manual prompt only` };
  if (!a.run) return { name: a.name, fired: false, reason: "eligible but no run command declared" };
  const r = spawnSync("bash", ["-c", a.run], { stdio: "inherit", cwd: anchor });
  const exit = r.status ?? 1;
  try {
    const p = join(anchor, ".harness", "automations.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), name: a.name, exit }) + "\n");
  } catch {
    /* ledger best-effort -- never fail a run over it */
  }
  return { name: a.name, fired: true, exit };
}
