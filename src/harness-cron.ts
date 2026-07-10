import type { Automation } from "./harness-manifest";
import { statusOf, fireAutomation } from "./harness-automate";

/**
 * The fire-eligible cron sweep (Phase 6, docs/harness/21 -- L12, second half of the
 * learning loop). A scheduler (cron/launchd) invokes this on a timer; it never
 * decides eligibility itself -- that stays `harness-automate.ts`'s job (the 4-box
 * gate). This module only sequences the sweep: fire what's eligible+runnable,
 * skip and name the reason for everything else, never throw.
 */

export interface FireEligibleResult {
  readonly fired: readonly { name: string; exit: number }[];
  readonly skipped: readonly { name: string; reason: string }[];
}

export function fireEligible(
  anchor: string,
  automations: readonly Automation[],
  opts?: { only?: readonly string[] },
): FireEligibleResult {
  const only = opts?.only;
  const items = only ? automations.filter((a) => only.includes(a.name)) : automations;

  const fired: { name: string; exit: number }[] = [];
  const skipped: { name: string; reason: string }[] = [];

  for (const a of items) {
    const s = statusOf(a);
    if (s.runnable) {
      try {
        const r = fireAutomation(anchor, a);
        fired.push({ name: a.name, exit: r.exit ?? 1 });
      } catch {
        fired.push({ name: a.name, exit: 1 });
      }
      continue;
    }
    const reason = s.eligible ? "eligible but no run command" : `missing: ${s.missing.join(", ")}`;
    skipped.push({ name: a.name, reason });
  }

  return { fired, skipped };
}
