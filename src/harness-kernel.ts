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
}

export const KERNEL_TIER_REGISTRY: Readonly<Record<string, TierEntry>> = {
  reason: { provider: "anthropic", model: "opus-4.8 / fable", transport: "native", role: "judgment" },
  scoped: { provider: "anthropic", model: "sonnet", transport: "native", role: "judgment" },
  mechanical: { provider: "anthropic", model: "haiku", transport: "native", role: "labor" },
  bulk: { provider: "zai", model: "glm-5.2 / glm-4.7", transport: "native", role: "labor" },
  "fast-cheap": { provider: "xai", model: "grok-4.1-fast", transport: "gateway", role: "labor" },
  "frontier-alt": { provider: "xai", model: "grok-4.5", transport: "gateway", role: "judgment" },
  beast: { provider: "runpod", model: "open-weight (vllm)", transport: "gateway", role: "labor" },
};

export const KERNEL_DEFAULTS: Partial<HarnessManifest> = {
  loop: { anchor: "claude-agent-sdk", boundary: "acp" },
  routing: { tiers: ["reason", "scoped", "mechanical"], default: "scoped", gateway: "litellm" },
  observability: { spans: "otel-genai", cost_metric: "cost_per_accepted_change" },
  safety: { lethal_trifecta_block: true },
  reliability: { idempotency: "required" },
  authoring: { emit: ["agents-md", "claude-dir"] },
};
