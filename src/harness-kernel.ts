import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HarnessManifest } from "./harness-manifest";

/**
 * The harness/v1 kernel seed (Phase 0, 0.2b) -- the shared, versioned defaults
 * every project inherits (docs/harness/01 + 02). The code half (tier registry,
 * gate patterns, presets, defaults) lives here; the prose half (contract + pack +
 * boot templates + default skills) lives in the file kernel at ../kernel/. The
 * two managed (non-overridable) floor keys live here so the band has something to
 * protect: observability.spans + safety.lethal_trifecta_block (see harness-merge
 * MANAGED_PATHS). Kept minimal on purpose -- the kernel grows reactively.
 */

/**
 * Single source of the kernel version: the file kernel's manifest
 * (engine/lingot/kernel/kernel.json). Both the emit path (AGENTS.md) and the
 * compile path (packs) resolve the version from here, so a venture's compiled
 * contract and its shadow packs always stamp the same number -- the seam the P4
 * reconciliation closed. Read once at module load; deterministic, no clock.
 */
const KERNEL_JSON = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel", "kernel.json");
export const KERNEL_VERSION: string = (JSON.parse(readFileSync(KERNEL_JSON, "utf8")) as { kernel: string }).kernel;

/**
 * The tier registry -- alias -> concrete (provider, model, transport, role).
 * Lives in the kernel (docs/harness/11). Endpoint URLs + tokens are NOT here;
 * they resolve machine-local at dispatch (L9). Models are descriptive labels
 * verified 2026-07-08 (the routing study ladder); pin exact ids per provider at
 * dispatch. `role` encodes the route-by-judgment floor: a gate/refuter never
 * routes to a "labor" tier.
 */
export interface TierEntry {
  readonly provider: string;
  readonly model: string;
  readonly transport: "native" | "gateway";
  readonly role: "judgment" | "labor";
  /** Native non-Anthropic endpoint (e.g. Z.ai): the env var holding the auth token. */
  readonly tokenEnv?: string;
  /** Native non-Anthropic endpoint: the fixed base URL. */
  readonly baseUrl?: string;
  /** Reach via the self-hosted LiteLLM gateway (OpenAI-only providers: Grok, vLLM). */
  readonly gateway?: boolean;
  /** APPROXIMATE price, USD per million tokens (in/out), for cost estimation. Edit as provider pricing moves. */
  readonly price?: { readonly in: number; readonly out: number };
}

export const KERNEL_TIER_REGISTRY: Readonly<Record<string, TierEntry>> = {
  // Anthropic native -- session default creds (no base-URL override; in-session via the Agent tool).
  reason: { provider: "anthropic", model: "opus-4.8 / fable", transport: "native", role: "judgment", price: { in: 15, out: 75 } },
  scoped: { provider: "anthropic", model: "sonnet", transport: "native", role: "judgment", price: { in: 3, out: 15 } },
  mechanical: { provider: "anthropic", model: "haiku", transport: "native", role: "labor", price: { in: 0.8, out: 4 } },
  // Z.ai GLM -- native Anthropic-compatible endpoint, own token (no gateway).
  bulk: {
    provider: "zai", model: "glm-5.2", transport: "native", role: "labor",
    tokenEnv: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/anthropic", price: { in: 0.6, out: 2.2 },
  },
  // xAI Grok + RunPod vLLM -- OpenAI-only, reached through the LiteLLM gateway.
  "fast-cheap": { provider: "xai", model: "grok-4.1-fast", transport: "gateway", role: "labor", gateway: true, price: { in: 0.5, out: 1.5 } },
  "frontier-alt": { provider: "xai", model: "grok-4.5", transport: "gateway", role: "judgment", gateway: true, price: { in: 3, out: 15 } },
  // beast is NOT grunt-work. It is the deliberate BURST supercompute lane: spin up
  // a full open-weight model on RunPod GPUs and let it reason over the entire
  // codebase / a huge context, on-demand when Felix triggers it. GPU-time-billed
  // (per-second), not per-token. NOT part of auto-routing -- it's a manual heavy
  // lane. The model here is a placeholder; the real one (a large OSS reasoner) is
  // chosen at trigger time. (Design deferred to a later stage.)
  beast: { provider: "runpod", model: "qwen2.5-7b-instruct", transport: "gateway", role: "judgment", gateway: true, price: { in: 0, out: 0 } },
};

/**
 * Governance gate wall (docs/harness/17 + 13): map a gated release op to the
 * command patterns (ERE, matched against a tool's Bash command) that perform it.
 * A held op's pattern denies the tool at the PreToolUse boundary until the founder
 * clears it (`harness exec --clear <op>`). Kernel default; a venture may extend.
 * The fleet never self-authorizes a release op.
 */
export const KERNEL_GATE_PATTERNS: Readonly<Record<string, string>> = {
  deploy: "vercel|--prod|deploy|publish|promote|npm publish|git push",
  spend: "purchase|checkout|payment|--pay|stripe|charge|billing",
  "outbound-client-comms": "sendgrid|--send-email|send_message|mailx|/messages|twilio",
  trigger: "processTrigger|createMetaCampaign|activateCampaign",
  activation: "--activate|go-live|golive",
};

/**
 * Named tool-sets for `harness exec --tools <preset>` -- so common worker shapes
 * don't require memorizing the exact allow-list. A preset name expands to its
 * tools; presets and explicit tool names mix freely (e.g. `research,Bash`). The
 * `research` preset includes ToolSearch on purpose: a headless worker surfaces
 * WebSearch/WebFetch as DEFERRED tools, so without ToolSearch it literally
 * cannot load them (the gotcha the first research dispatch hit). Web tools stay
 * bounded by the token-less/secret-less worker env + the output moderation rail.
 */
export const TOOL_PRESETS: Readonly<Record<string, readonly string[]>> = {
  read: ["Read", "Glob", "Grep", "LS"],
  build: ["Read", "Glob", "Grep", "LS", "Write", "Edit", "Bash"],
  research: ["Read", "Glob", "Grep", "LS", "ToolSearch", "WebSearch", "WebFetch"],
};

/** Expand any preset names in a --tools list to their tools; dedup, order-stable. */
export function expandToolPresets(tools: readonly string[]): string[] {
  const out: string[] = [];
  for (const t of tools) {
    const preset = TOOL_PRESETS[t];
    if (preset) { for (const p of preset) if (!out.includes(p)) out.push(p); }
    else if (!out.includes(t)) out.push(t);
  }
  return out;
}

export const KERNEL_DEFAULTS: Partial<HarnessManifest> = {
  loop: { anchor: "claude-agent-sdk", boundary: "acp" },
  routing: { tiers: ["reason", "scoped", "mechanical"], default: "scoped", gateway: "litellm" },
  observability: { spans: "otel-genai", cost_metric: "cost_per_accepted_change" },
  safety: { lethal_trifecta_block: true },
  reliability: { idempotency: "required" },
  authoring: { emit: ["agents-md", "claude-dir"] },
};
