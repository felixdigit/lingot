import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AuditFn, AuditLine } from "./harness-slack-listen";

/**
 * The real audit sink for the Slack listener (Order J, SAFETY 5). Appends one
 * JSON line per approval/decline/correction/signal to the SAME trail the gate
 * hook writes (`<anchor>/.harness/audit.jsonl`, see harness-tool-gate.sh) --
 * one immutable ledger of every release act, whether it came from the tool
 * gate or a founder's Slack reaction. Returns false on any write failure so the
 * caller can fail-closed (SAFETY 6): an approval that cannot be audited is
 * refused, not silently taken.
 */
export function defaultAuditSink(anchor: string): AuditFn {
  return (line: AuditLine): boolean => {
    try {
      const path = join(anchor, ".harness", "audit.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, JSON.stringify(line) + "\n");
      return true;
    } catch {
      return false;
    }
  };
}
