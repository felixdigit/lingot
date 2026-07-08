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
}

export const KERNEL_TIER_REGISTRY: Readonly<Record<string, TierEntry>> = {
  // Anthropic native -- session default creds (no base-URL override; in-session via the Agent tool).
  reason: { provider: "anthropic", model: "opus-4.8 / fable", transport: "native", role: "judgment" },
  scoped: { provider: "anthropic", model: "sonnet", transport: "native", role: "judgment" },
  mechanical: { provider: "anthropic", model: "haiku", transport: "native", role: "labor" },
  // Z.ai GLM -- native Anthropic-compatible endpoint, own token (no gateway).
  bulk: {
    provider: "zai", model: "glm-5.2", transport: "native", role: "labor",
    tokenEnv: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/anthropic",
  },
  // xAI Grok + RunPod vLLM -- OpenAI-only, reached through the LiteLLM gateway.
  "fast-cheap": { provider: "xai", model: "grok-4.1-fast", transport: "gateway", role: "labor", gateway: true },
  "frontier-alt": { provider: "xai", model: "grok-4.5", transport: "gateway", role: "judgment", gateway: true },
  beast: { provider: "runpod", model: "open-weight (vllm)", transport: "gateway", role: "labor", gateway: true },
};

export const KERNEL_DEFAULTS: Partial<HarnessManifest> = {
  loop: { anchor: "claude-agent-sdk", boundary: "acp" },
  routing: { tiers: ["reason", "scoped", "mechanical"], default: "scoped", gateway: "litellm" },
  observability: { spans: "otel-genai", cost_metric: "cost_per_accepted_change" },
  safety: { lethal_trifecta_block: true },
  reliability: { idempotency: "required" },
  authoring: { emit: ["agents-md", "claude-dir"] },
};
