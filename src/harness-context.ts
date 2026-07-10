import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { estimateTokens } from "./tokenizer";

/**
 * Compiled context feed (docs/harness/10-context.md): the operating contract text a
 * dispatch sees, budgeted and provenance-stamped. Reads only AGENTS.md today -- more
 * sources (charters, RAG, dialect targeting) land as later slices per section 7.
 */

export interface CompiledContext {
  readonly text: string;
  readonly tokens: number;
  readonly truncated: boolean;
  readonly sources: readonly string[];
}

const DEFAULT_BUDGET = 6000;

/** Head share of the budget under truncation: primacy dominates the U-curve, so
 * the head keeps the larger slice; the tail keeps the actionable floor. */
const HEAD_SHARE = 0.65;

/**
 * Reads <anchor>/AGENTS.md and budgets it to `budgetTokens` (default 6000). Missing
 * file -> empty context, never throws. Over budget -> EDGE-PRESERVING truncation
 * on paragraph boundaries (docs/harness/prompt-design.md P4: attention over long
 * context is a U-curve -- both edges beat the middle, so truncation drops the
 * middle and never amputates an edge; the old tail-first cut removed exactly the
 * highest-compliance slot). The head keeps HEAD_SHARE of the budget (primacy
 * dominates), the tail keeps the rest, and an elision line marks what was
 * dropped. Never cuts mid-paragraph; always keeps at least the first paragraph
 * even if it alone exceeds the budget.
 */
export function compiledContextFor(anchor: string, budgetTokens: number = DEFAULT_BUDGET): CompiledContext {
  let raw: string;
  try {
    raw = readFileSync(join(anchor, "AGENTS.md"), "utf8");
  } catch {
    return { text: "", tokens: 0, truncated: false, sources: [] };
  }

  const fullTokens = estimateTokens(raw);
  if (fullTokens <= budgetTokens) {
    return { text: raw, tokens: fullTokens, truncated: false, sources: ["AGENTS.md"] };
  }

  const paragraphs = raw.split("\n\n");

  // Head pass: accumulate from the top while under the head share.
  const headBudget = Math.floor(budgetTokens * HEAD_SHARE);
  const head: string[] = [paragraphs[0]];
  let headTokens = estimateTokens(paragraphs[0]);
  let headEnd = 1; // index of the first paragraph NOT in the head
  for (; headEnd < paragraphs.length; headEnd++) {
    const t = estimateTokens(head.concat(paragraphs[headEnd]).join("\n\n"));
    if (t > headBudget) break;
    head.push(paragraphs[headEnd]);
    headTokens = t;
  }

  // Tail pass: accumulate from the bottom with the remaining budget, stopping
  // before overlapping the head. The elision marker is charged to the budget.
  const marker = (n: number): string => `[... ${n} paragraph(s) elided here for the context budget -- middle-priority content; both edges preserved per prompt-design P4 ...]`;
  const tail: string[] = [];
  let tailStart = paragraphs.length; // index of the first paragraph IN the tail
  for (let i = paragraphs.length - 1; i >= headEnd; i--) {
    const candidateTail = [paragraphs[i], ...tail];
    const elided = i - headEnd;
    const total = estimateTokens([...head, marker(Math.max(elided, 1)), ...candidateTail].join("\n\n"));
    if (total > budgetTokens) break;
    tail.unshift(paragraphs[i]);
    tailStart = i;
  }

  const elidedCount = tailStart - headEnd;
  if (tail.length === 0 || elidedCount <= 0) {
    // Budget too tight for both edges: keep the head slice alone (primacy wins).
    const text = head.join("\n\n");
    return { text, tokens: estimateTokens(text), truncated: true, sources: ["AGENTS.md"] };
  }

  const text = [...head, marker(elidedCount), ...tail].join("\n\n");
  return { text, tokens: estimateTokens(text), truncated: true, sources: ["AGENTS.md"] };
}

export interface RetrievedMemory {
  readonly text: string;
  readonly tokens: number;
  /** Set when retrieval did not run/produce (no command, error, empty) -- honest skip. */
  readonly skipped?: string;
}

/**
 * L5 runtime retrieval: run the venture's declared retrieval command (e.g.
 * "pnpm brain:query") IN THE EXECUTOR (parent env holds the DB/API creds; the
 * worker only ever sees the returned text), with the task as a single safe arg.
 * Budgeted like the contract; never throws; empty/failed -> honest skip.
 */
export function retrievedMemory(
  anchor: string,
  retrievalCmd: string | undefined,
  query: string,
  budgetTokens = 2000,
): RetrievedMemory {
  if (!retrievalCmd) return { text: "", tokens: 0, skipped: "no state.memory.retrieval declared" };
  try {
    const r = spawnSync("bash", ["-c", `${retrievalCmd} "$1"`, "harness-mem", query], {
      cwd: anchor,
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const out = (r.stdout ?? "").trim();
    if (r.status !== 0 || !out) {
      return { text: "", tokens: 0, skipped: r.status !== 0 ? `retrieval exited ${r.status}` : "retrieval returned nothing" };
    }
    let text = out;
    let tokens = estimateTokens(text);
    if (tokens > budgetTokens) {
      // rough char-proportional trim, then re-measure -- retrieval is a signal, not the contract
      text = text.slice(0, Math.max(1, Math.floor((budgetTokens / tokens) * text.length)));
      tokens = estimateTokens(text);
    }
    return { text, tokens };
  } catch (e: any) {
    return { text: "", tokens: 0, skipped: `retrieval error: ${e?.message ?? e}` };
  }
}
