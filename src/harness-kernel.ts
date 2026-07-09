import type { HarnessManifest } from "./harness-manifest";

/**
 * The harness/v1 kernel seed (Phase 0, 0.2b) -- the shared, versioned defaults
 * every project inherits (docs/harness/01 + 02). Code-defined for the seed; a
 * later increment moves it to a versioned, file-based kernel. The two managed
 * (non-overridable) floor keys live here so the band has something to protect:
 * observability.spans + safety.lethal_trifecta_block (see harness-merge
 * MANAGED_PATHS). Kept minimal on purpose -- the kernel grows reactively.
 */

export const KERNEL_VERSION = "1.0.0-seed";

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
  // beast is GPU-time-billed (RunPod per-second), not per-token -- price 0; GPU cost tracked separately.
  beast: { provider: "runpod", model: "qwen2.5-7b-instruct", transport: "gateway", role: "labor", gateway: true, price: { in: 0, out: 0 } },
};

export const KERNEL_DEFAULTS: Partial<HarnessManifest> = {
  loop: { anchor: "claude-agent-sdk", boundary: "acp" },
  routing: { tiers: ["reason", "scoped", "mechanical"], default: "scoped", gateway: "litellm" },
  observability: { spans: "otel-genai", cost_metric: "cost_per_accepted_change" },
  safety: { lethal_trifecta_block: true },
  reliability: { idempotency: "required" },
  authoring: { emit: ["agents-md", "claude-dir"] },
};
