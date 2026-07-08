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

export const KERNEL_DEFAULTS: Partial<HarnessManifest> = {
  loop: { anchor: "claude-agent-sdk", boundary: "acp" },
  routing: { tiers: ["reason", "scoped", "mechanical"], default: "scoped", gateway: "litellm" },
  observability: { spans: "otel-genai", cost_metric: "cost_per_accepted_change" },
  safety: { lethal_trifecta_block: true },
  reliability: { idempotency: "required" },
  authoring: { emit: ["agents-md", "claude-dir"] },
};
