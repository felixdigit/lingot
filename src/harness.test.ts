import { describe, it, expect } from "vitest";
import { deepMerge, enforceManagedBand, resolveProject } from "./harness-merge";
import { isHarnessManifest } from "./harness-manifest";
import { tierEnv, formatTierEnv } from "./harness-dispatch";
import type { TierEntry } from "./harness-kernel";
import { summarizeUsage, estimateCostUsd } from "./harness-usage";
import { matchesExpect } from "./harness-eval";
import { makeMcpProbe } from "./harness-verdict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("deepMerge (kernel (+) overlay)", () => {
  it("scalars override, arrays concat + dedup, objects deep-merge; overlay wins", () => {
    const base = { a: 1, list: ["x", "y"], obj: { keep: 1, drop: 1 } };
    const overlay = { a: 2, list: ["y", "z"], obj: { drop: 2 } };
    expect(deepMerge(base, overlay)).toEqual({ a: 2, list: ["x", "y", "z"], obj: { keep: 1, drop: 2 } });
  });
  it("undefined overlay leaves the base value in place", () => {
    expect(deepMerge({ a: 1 }, { a: undefined })).toEqual({ a: 1 });
  });
});

describe("the non-overridable managed band", () => {
  it("rejects an overlay that sets a managed key", () => {
    const errs = enforceManagedBand({ observability: { spans: "custom" } });
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("observability.spans");
  });
  it("allows an overlay that touches nothing managed", () => {
    expect(enforceManagedBand({ routing: { tiers: ["scoped"] } })).toEqual([]);
  });
  it("resolveProject blocks a managed override, merges an ok overlay", () => {
    const manifest: any = { harness: "harness/v1", identity: { name: "x", kind: "venture", owners: ["felix"] }, kernel: { version: "~>1" } };
    expect(resolveProject({ observability: { spans: "otel-genai" } }, { ...manifest, observability: { spans: "no" } }).resolved).toBeUndefined();
    expect(resolveProject({ loop: { anchor: "claude-agent-sdk" } }, manifest).resolved).toBeDefined();
  });
});

describe("isHarnessManifest", () => {
  it("discriminates harness/v1 from v0 / blocks", () => {
    expect(isHarnessManifest({ harness: "harness/v1", identity: {} })).toBe(true);
    expect(isHarnessManifest({ manifest: "lingot/v0", identity: {} })).toBe(false);
    expect(isHarnessManifest({ name: "block", domain: "x" })).toBe(false);
  });
});

describe("tierEnv (the launch shim) -- and it never leaks a token value", () => {
  const reg: Record<string, TierEntry> = {
    reason: { provider: "anthropic", model: "opus", transport: "native", role: "judgment" },
    bulk: { provider: "zai", model: "glm-5.2", transport: "native", role: "labor", tokenEnv: "ZAI_API_KEY", baseUrl: "https://api.z.ai/api/anthropic" },
    beast: { provider: "runpod", model: "qwen", transport: "gateway", role: "labor", gateway: true },
  };
  it("anthropic native -> no override", () => {
    expect(tierEnv("reason", {}, reg).env).toEqual({});
  });
  it("z.ai with token -> base+token+model; token value redacted in the formatted view", () => {
    const r = tierEnv("bulk", { ZAI_API_KEY: "sk-secret-value" }, reg);
    expect(r.env?.ANTHROPIC_BASE_URL).toBe("https://api.z.ai/api/anthropic");
    expect(r.env?.ANTHROPIC_AUTH_TOKEN).toBe("sk-secret-value");
    expect(formatTierEnv(r)).not.toContain("sk-secret-value");
    expect(formatTierEnv(r)).toContain("***redacted***");
  });
  it("z.ai without the token -> HELD, names the missing var", () => {
    const r = tierEnv("bulk", {}, reg);
    expect(r.missing).toEqual(["ZAI_API_KEY"]);
  });
  it("gateway tier without gateway env -> HELD, names both vars", () => {
    const r = tierEnv("beast", {}, reg);
    expect(r.missing).toEqual(["LITELLM_BASE_URL", "LITELLM_MASTER_KEY"]);
  });
});

describe("cost", () => {
  it("estimateCostUsd = in/1e6*inPrice + out/1e6*outPrice; 0 without a price", () => {
    expect(estimateCostUsd(1_000_000, 1_000_000, { in: 3, out: 15 })).toBeCloseTo(18, 6);
    expect(estimateCostUsd(500_000, 0, { in: 0.6, out: 2.2 })).toBeCloseTo(0.3, 6);
    expect(estimateCostUsd(1000, 1000, undefined)).toBe(0);
  });
  it("summarizeUsage totals cost per tier + overall, and splits labor vs judgment", () => {
    const s = summarizeUsage([
      { at: "", tier: "bulk", provider: "zai", model: "glm", role: "labor", exit: 0, costUsd: 0.01 },
      { at: "", tier: "bulk", provider: "zai", model: "glm", role: "labor", exit: 0, costUsd: 0.02 },
      { at: "", tier: "reason", provider: "anthropic", model: "opus", role: "judgment", exit: 0, costUsd: 0.5 },
    ]);
    expect(s.total).toBe(3);
    expect(s.byTier).toEqual({ bulk: 2, reason: 1 });
    expect(s.byRole).toEqual({ judgment: 1, labor: 2 });
    expect(s.totalCostUsd).toBeCloseTo(0.53, 6);
    expect(s.costByTier).toEqual({ bulk: 0.03, reason: 0.5 });
  });
});

describe("matchesExpect (eval scoring)", () => {
  it("substring by default, /regex/flags when slash-wrapped, false on a bad regex", () => {
    expect(matchesExpect("hello world", "world")).toBe(true);
    expect(matchesExpect("hello world", "nope")).toBe(false);
    expect(matchesExpect("PONG-42", "/pong-\\d+/i")).toBe(true);
    expect(matchesExpect("abc", "/[/")).toBe(false);
  });
});

describe("makeMcpProbe (structural mcp reachability)", () => {
  it("a declared server is reachable iff configured in the nearest .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-"));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { supabase: {}, "agency-brain": {} } }));
    const probe = makeMcpProbe(dir);
    expect(probe("supabase")).toBe(true);
    expect(probe("agency-brain")).toBe(true);
    expect(probe("nonexistent")).toBe(false);
  });
});
