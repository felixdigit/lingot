import { KERNEL_TIER_REGISTRY, type TierEntry } from "./harness-kernel";

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
