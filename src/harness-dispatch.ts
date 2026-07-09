import { spawnSync } from "node:child_process";
import { KERNEL_TIER_REGISTRY, type TierEntry } from "./harness-kernel";
import { estimateCostUsd } from "./harness-usage";

export interface MeasuredRun {
  readonly text: string;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly costUsd: number;
  readonly exit: number;
}

/**
 * Run a headless `claude -p <prompt>` with a tier's env and capture usage/cost
 * (via --output-format json). Reused by `harness run` (single) and `harness
 * batch` (fan-out). Never returns a token value; returns the result text +
 * token counts + estimated cost.
 */
/**
 * LEAN dispatch: a direct Anthropic-format `/v1/messages` call to the tier, with
 * just the prompt -- NO Claude Code agent scaffold (no tools, no repo context).
 * For pure text labor (summarize/classify/transform), this is ~prompt-sized
 * context instead of the ~59k the agent wrap carries, so cheap labor is actually
 * cheap. Requires a resolved external endpoint + model (bulk/beast/grok); the
 * Anthropic tiers have no model id here, so use `run` (in-session) for those.
 */
export async function leanRun(
  prompt: string,
  resolvedEnv: Readonly<Record<string, string>> = {},
  price?: { in: number; out: number },
): Promise<MeasuredRun> {
  const model = resolvedEnv.ANTHROPIC_MODEL;
  const baseUrl = resolvedEnv.ANTHROPIC_BASE_URL;
  const token = resolvedEnv.ANTHROPIC_AUTH_TOKEN;
  if (!model || !baseUrl || !token) {
    return {
      text: "lean/ask needs a resolved external endpoint + model (bulk/beast/grok); use `harness run` for the Anthropic tiers.",
      inTokens: 0, outTokens: 0, costUsd: 0, exit: 2,
    };
  }
  try {
    const r = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}`, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
    });
    const j: any = await r.json().catch(() => ({}));
    const text = j?.content?.[0]?.text ?? (j?.error?.message ? `ERR: ${j.error.message}` : "");
    const inTokens = (j?.usage?.input_tokens ?? 0) + (j?.usage?.cache_read_input_tokens ?? 0) + (j?.usage?.cache_creation_input_tokens ?? 0);
    const outTokens = j?.usage?.output_tokens ?? 0;
    return { text, inTokens, outTokens, costUsd: estimateCostUsd(inTokens, outTokens, price), exit: r.ok ? 0 : 1 };
  } catch (e: any) {
    return { text: `ERR: ${e?.message ?? e}`, inTokens: 0, outTokens: 0, costUsd: 0, exit: 1 };
  }
}

export function measuredClaudeRun(prompt: string, env: NodeJS.ProcessEnv, price?: { in: number; out: number }): MeasuredRun {
  const r = spawnSync("claude", ["-p", "--output-format", "json", prompt], { encoding: "utf8", env });
  let inTokens = 0, outTokens = 0, text = r.stdout ?? "";
  try {
    const j = JSON.parse(r.stdout ?? "{}");
    text = j.result ?? text;
    inTokens = (j.usage?.input_tokens ?? 0) + (j.usage?.cache_read_input_tokens ?? 0) + (j.usage?.cache_creation_input_tokens ?? 0);
    outTokens = j.usage?.output_tokens ?? 0;
  } catch {
    /* not json -- return raw text, zero tokens */
  }
  return { text, inTokens, outTokens, costUsd: estimateCostUsd(inTokens, outTokens, price), exit: r.status ?? 0 };
}

/**
 * The launch shim (Phase 4, docs/harness/04) -- resolve a tier alias into the
 * per-process env a loop anchor needs to run on that tier. The Claude Code
 * Agent-tool model is a hardcoded enum and ANTHROPIC_BASE_URL is process-global,
 * so external tiers are reached by launching a process with the right env, not
 * by an in-session model switch. This module builds that env block; it NEVER
 * returns or logs a token VALUE (only which env var it came from). Tokens
 * resolve machine-local from `env` (default process.env, L9).
 */

export interface TierEnvResult {
  readonly alias: string;
  /** The process env overrides to launch the anchor on this tier. */
  readonly env?: Readonly<Record<string, string>>;
  /** Human note -- redacted; never a token value. */
  readonly note: string;
  /** Required env vars that are not set (the tier is HELD until they are). */
  readonly missing?: readonly string[];
}

export function tierEnv(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
  registry: Readonly<Record<string, TierEntry>> = KERNEL_TIER_REGISTRY,
): TierEnvResult {
  const t = registry[alias];
  if (!t) return { alias, note: `unknown tier "${alias}"`, missing: [] };

  // Anthropic native -- use the session's default creds; no base-URL override.
  if (t.provider === "anthropic" && !t.baseUrl && !t.gateway) {
    return { alias, env: {}, note: `anthropic native (${t.model}); session default creds, no base-URL override` };
  }

  // Native non-Anthropic endpoint (Z.ai): own token, fixed base URL.
  if (t.baseUrl && t.tokenEnv) {
    const tok = env[t.tokenEnv];
    if (!tok) return { alias, note: `${t.provider} ${t.model} @ ${t.baseUrl}`, missing: [t.tokenEnv] };
    return {
      alias,
      env: { ANTHROPIC_BASE_URL: t.baseUrl, ANTHROPIC_AUTH_TOKEN: tok, ANTHROPIC_MODEL: t.model },
      note: `${t.provider} ${t.model} @ ${t.baseUrl} (token from ${t.tokenEnv})`,
    };
  }

  // Gateway (Grok / vLLM via the self-hosted LiteLLM proxy).
  if (t.gateway) {
    const base = env.LITELLM_BASE_URL;
    const key = env.LITELLM_MASTER_KEY;
    const missing = [base ? null : "LITELLM_BASE_URL", key ? null : "LITELLM_MASTER_KEY"].filter(
      (x): x is string => x !== null,
    );
    if (missing.length) return { alias, note: `${t.provider} ${t.model} via LiteLLM gateway`, missing };
    return {
      alias,
      env: { ANTHROPIC_BASE_URL: base!.replace(/\/+$/, ""), ANTHROPIC_AUTH_TOKEN: key!, ANTHROPIC_MODEL: t.model },
      note: `${t.provider} ${t.model} via LiteLLM gateway @ ${base} (token from LITELLM_MASTER_KEY)`,
    };
  }

  return { alias, note: `tier "${alias}" has no dispatch mapping`, missing: [] };
}

/** Redacted, human-readable view of a tier's env block. Token VALUES are never shown. */
export function formatTierEnv(r: TierEnvResult): string {
  if (r.missing && r.missing.length > 0) {
    return `tier ${r.alias}: HELD -- set ${r.missing.join(", ")}  (${r.note})`;
  }
  const entries = Object.entries(r.env ?? {});
  const lines = [`tier ${r.alias}: ${r.note}`];
  if (entries.length === 0) {
    lines.push("  (no env overrides -- session default Anthropic)");
  } else {
    for (const [k, v] of entries) {
      const secret = k.includes("TOKEN") || k.includes("KEY");
      lines.push(`  ${k}=${secret ? "***redacted***" : v}`);
    }
  }
  return lines.join("\n");
}
