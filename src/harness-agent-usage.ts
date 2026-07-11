import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { KERNEL_TIER_REGISTRY, type TierEntry } from "./harness-kernel";
import { recordDispatch, costFromUsage, type DispatchRecord } from "./harness-usage";

/**
 * Agent-path telemetry (docs/harness/15, second slice -- the ortova finding).
 * The ledger's first slice only saw `harness run/ask/batch/exec`, but the real
 * fleet runs through Claude Code's Agent tool, so the first big session recorded
 * 2 ledger lines against ~34 dispatches. This module closes that hole: a
 * SubagentStop hook feeds each finished subagent's transcript through
 * `harness record-agent`, which sums the per-API-call usage blocks and appends
 * DispatchRecords with source:"agent" -- same ledger, same summary, same
 * cost-per-accepted-change denominator.
 *
 * Double-count safety: a byte watermark per transcript path
 * (.harness/agent-usage-state.json). SubagentStop can fire again for the same
 * agent (SendMessage resume); only bytes past the watermark are counted, so a
 * refire records the DELTA. Sidechain safety: if the payload hands us a MAIN
 * session transcript (embedded sidechains), only isSidechain lines are counted;
 * a dedicated agent transcript (no explicit sidechain flags) counts every
 * assistant line.
 */

interface UsageBlock {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ModelUsage {
  readonly model: string;
  readonly calls: number;
  readonly usage: Required<UsageBlock>;
}

/** Map a concrete model id from a transcript to its kernel tier. */
export function classifyModel(modelId: string): { tier: string; entry?: TierEntry } {
  const m = modelId.toLowerCase();
  const pick = (tier: string) => ({ tier, entry: KERNEL_TIER_REGISTRY[tier] });
  if (m.includes("fable") || m.includes("opus") || m.includes("mythos")) return pick("reason");
  if (m.includes("sonnet")) return pick("scoped");
  if (m.includes("haiku")) return pick("mechanical");
  if (m.includes("glm")) return pick("bulk");
  if (m.includes("grok") && m.includes("fast")) return pick("fast-cheap");
  if (m.includes("grok")) return pick("frontier-alt");
  return { tier: "unmapped" };
}

/**
 * Sum assistant-message usage from a transcript slice (JSONL text). Returns one
 * entry per model seen. `<synthetic>` models (harness-injected notices) are
 * skipped -- they carry no billable usage.
 */
export function sumTranscriptUsage(jsonlText: string): ModelUsage[] {
  const perModel = new Map<string, { calls: number; usage: Required<UsageBlock> }>();
  let sawSidechainFlag = false;
  // Two line shapes exist in the wild: the wrapped one ({type:"assistant",
  // message:{model,usage}}) and the flat one the hooks doc describes
  // ({role:"assistant", model, usage}). Accept both.
  type Line = {
    type?: string;
    role?: string;
    model?: string;
    usage?: UsageBlock;
    isSidechain?: boolean;
    message?: { model?: string; usage?: UsageBlock };
  };
  const lines: Line[] = [];
  for (const raw of jsonlText.split("\n")) {
    const s = raw.trim();
    if (!s) continue;
    try {
      const l = JSON.parse(s) as Line;
      lines.push(l);
      if (l.isSidechain === true) sawSidechainFlag = true;
    } catch {
      /* partial trailing line (transcript mid-write) -- skip */
    }
  }
  for (const l of lines) {
    const isAssistant = l.type === "assistant" || l.role === "assistant";
    if (!isAssistant) continue;
    if (sawSidechainFlag && l.isSidechain !== true) continue; // main transcript: agent lines only
    const model = l.message?.model ?? l.model;
    const u = l.message?.usage ?? l.usage;
    if (!model || !u || model.includes("synthetic")) continue;
    const cur = perModel.get(model) ?? {
      calls: 0,
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    };
    cur.calls += 1;
    cur.usage.input_tokens += u.input_tokens ?? 0;
    cur.usage.output_tokens += u.output_tokens ?? 0;
    cur.usage.cache_read_input_tokens += u.cache_read_input_tokens ?? 0;
    cur.usage.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0;
    perModel.set(model, cur);
  }
  return [...perModel.entries()].map(([model, v]) => ({ model, calls: v.calls, usage: v.usage }));
}

const statePath = (root: string): string => join(root, ".harness", "agent-usage-state.json");

function readState(root: string): Record<string, number> {
  try {
    return JSON.parse(readFileSync(statePath(root), "utf8")) as Record<string, number>;
  } catch {
    return {};
  }
}

function writeState(root: string, state: Record<string, number>): void {
  try {
    mkdirSync(dirname(statePath(root)), { recursive: true });
    writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n");
  } catch {
    /* best-effort, like the ledger */
  }
}

export interface AgentUsageResult {
  readonly records: readonly DispatchRecord[];
  readonly bytesProcessed: number;
  readonly note: string;
}

/**
 * Process one SubagentStop payload: read the transcript past this root's
 * watermark, sum usage, append one DispatchRecord per model, advance the
 * watermark. Idempotent per byte range; safe to fire repeatedly.
 */
export function recordAgentStop(root: string, transcriptPath: string, label?: string): AgentUsageResult {
  let size: number;
  try {
    size = statSync(transcriptPath).size;
  } catch {
    return { records: [], bytesProcessed: 0, note: `transcript not found: ${transcriptPath}` };
  }
  const state = readState(root);
  const offset = Math.min(state[transcriptPath] ?? 0, size);
  if (size <= offset) return { records: [], bytesProcessed: 0, note: "no new bytes past watermark" };

  let slice: string;
  try {
    slice = readFileSync(transcriptPath, "utf8").slice(offset);
  } catch (e: unknown) {
    return { records: [], bytesProcessed: 0, note: `unreadable transcript: ${(e as Error).message}` };
  }

  const sums = sumTranscriptUsage(slice);
  const at = new Date().toISOString();
  const records: DispatchRecord[] = sums.map((s) => {
    const { tier, entry } = classifyModel(s.model);
    const inTokens =
      s.usage.input_tokens + s.usage.cache_read_input_tokens + s.usage.cache_creation_input_tokens;
    return {
      at,
      tier,
      provider: entry?.provider ?? "anthropic",
      model: s.model,
      role: entry?.role ?? "labor",
      exit: 0, // a completed stop; acceptance still means review, but stop is the closest mechanical signal
      inTokens,
      outTokens: s.usage.output_tokens,
      costUsd: costFromUsage(s.usage, entry?.price),
      source: "agent",
      label: (label ?? basename(transcriptPath)).slice(0, 40),
    };
  });
  for (const r of records) recordDispatch(root, r);
  state[transcriptPath] = size;
  // keep the state file bounded: drop watermarks for transcripts that no longer exist
  for (const p of Object.keys(state)) {
    try {
      statSync(p);
    } catch {
      delete state[p];
    }
  }
  writeState(root, state);
  const note = records.length
    ? records.map((r) => `${r.model}: ${r.inTokens}in/${r.outTokens}out $${(r.costUsd ?? 0).toFixed(4)} -> ${r.tier}`).join("; ")
    : "no billable assistant usage in slice";
  return { records, bytesProcessed: size - offset, note };
}
