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

/**
 * Reads <anchor>/AGENTS.md and budgets it to `budgetTokens` (default 6000). Missing
 * file -> empty context, never throws. Over budget -> truncate on paragraph
 * boundaries (split on \n\n), accumulating paragraphs while the running
 * estimateTokens total stays <= budget. Never cuts mid-paragraph; always keeps at
 * least the first paragraph even if it alone exceeds the budget.
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
  const kept: string[] = [paragraphs[0]];
  let text = paragraphs[0];
  let tokens = estimateTokens(text);
  for (let i = 1; i < paragraphs.length; i++) {
    const candidate = kept.concat(paragraphs[i]).join("\n\n");
    const candidateTokens = estimateTokens(candidate);
    if (candidateTokens > budgetTokens) break;
    kept.push(paragraphs[i]);
    text = candidate;
    tokens = candidateTokens;
  }

  return { text, tokens, truncated: true, sources: ["AGENTS.md"] };
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
