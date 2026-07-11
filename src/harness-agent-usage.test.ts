import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyModel, sumTranscriptUsage, recordAgentStop } from "./harness-agent-usage";
import { summarizeUsage, formatUsage, type DispatchRecord } from "./harness-usage";

const wrapped = (model: string, usage: Record<string, number>, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "assistant", message: { model, usage }, ...extra });
const flat = (model: string, usage: Record<string, number>) =>
  JSON.stringify({ role: "assistant", model, usage });

describe("classifyModel", () => {
  it("maps concrete ids to kernel tiers", () => {
    expect(classifyModel("claude-fable-5").tier).toBe("reason");
    expect(classifyModel("claude-opus-4-8").tier).toBe("reason");
    expect(classifyModel("claude-sonnet-5").tier).toBe("scoped");
    expect(classifyModel("claude-haiku-4-5-20251001").tier).toBe("mechanical");
    expect(classifyModel("glm-5.2").tier).toBe("bulk");
    expect(classifyModel("grok-4.1-fast").tier).toBe("fast-cheap");
    expect(classifyModel("grok-4.5").tier).toBe("frontier-alt");
  });
  it("leaves unknown models unmapped (visible, unpriced)", () => {
    const c = classifyModel("mistral-large");
    expect(c.tier).toBe("unmapped");
    expect(c.entry).toBeUndefined();
  });
});

describe("sumTranscriptUsage", () => {
  it("sums wrapped assistant lines per model", () => {
    const text = [
      wrapped("claude-sonnet-5", { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100 }),
      wrapped("claude-sonnet-5", { input_tokens: 5, output_tokens: 15, cache_creation_input_tokens: 50 }),
      JSON.stringify({ type: "user", message: {} }),
    ].join("\n");
    const s = sumTranscriptUsage(text);
    expect(s).toHaveLength(1);
    expect(s[0].model).toBe("claude-sonnet-5");
    expect(s[0].calls).toBe(2);
    expect(s[0].usage.input_tokens).toBe(15);
    expect(s[0].usage.output_tokens).toBe(35);
    expect(s[0].usage.cache_read_input_tokens).toBe(100);
    expect(s[0].usage.cache_creation_input_tokens).toBe(50);
  });

  it("accepts the flat line shape from the hooks doc", () => {
    const s = sumTranscriptUsage(flat("claude-haiku-4-5", { input_tokens: 3, output_tokens: 7 }));
    expect(s).toHaveLength(1);
    expect(s[0].usage.output_tokens).toBe(7);
  });

  it("counts only sidechain lines when a main transcript embeds them", () => {
    const text = [
      wrapped("claude-fable-5", { input_tokens: 1000, output_tokens: 500 }), // HQ line, no flag
      wrapped("claude-sonnet-5", { input_tokens: 10, output_tokens: 20 }, { isSidechain: true }),
    ].join("\n");
    const s = sumTranscriptUsage(text);
    expect(s).toHaveLength(1);
    expect(s[0].model).toBe("claude-sonnet-5");
  });

  it("skips synthetic models and survives a partial trailing line", () => {
    const text =
      wrapped("<synthetic>", { input_tokens: 9, output_tokens: 9 }) +
      "\n" +
      wrapped("claude-sonnet-5", { input_tokens: 1, output_tokens: 2 }) +
      '\n{"type":"assist';
    const s = sumTranscriptUsage(text);
    expect(s).toHaveLength(1);
    expect(s[0].model).toBe("claude-sonnet-5");
  });
});

describe("recordAgentStop", () => {
  let root: string;
  let transcript: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "harness-agent-usage-"));
    transcript = join(root, "agent-abc123.jsonl");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const ledger = (): DispatchRecord[] =>
    readFileSync(join(root, ".harness", "usage.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as DispatchRecord);

  it("appends one priced record per model with source=agent", () => {
    writeFileSync(
      transcript,
      wrapped("claude-sonnet-5", { input_tokens: 1_000_000, output_tokens: 1_000_000 }) + "\n",
    );
    const res = recordAgentStop(root, transcript, "Explore");
    expect(res.records).toHaveLength(1);
    const r = ledger()[0];
    expect(r.source).toBe("agent");
    expect(r.tier).toBe("scoped");
    expect(r.role).toBe("judgment");
    expect(r.label).toBe("Explore");
    expect(r.costUsd).toBeCloseTo(3 + 15, 5); // 1M fresh in @ $3 + 1M out @ $15
  });

  it("prices cache reads at 0.1x and creation at 1.25x of input", () => {
    writeFileSync(
      transcript,
      wrapped("claude-sonnet-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }) + "\n",
    );
    recordAgentStop(root, transcript);
    expect(ledger()[0].costUsd).toBeCloseTo(3 * 0.1 + 3 * 1.25, 5);
  });

  it("is watermark-idempotent: a refire with no new bytes records nothing", () => {
    writeFileSync(transcript, wrapped("claude-sonnet-5", { input_tokens: 10, output_tokens: 10 }) + "\n");
    expect(recordAgentStop(root, transcript).records).toHaveLength(1);
    expect(recordAgentStop(root, transcript).records).toHaveLength(0);
    expect(ledger()).toHaveLength(1);
  });

  it("records only the delta after a resume appends new turns", () => {
    writeFileSync(transcript, wrapped("claude-sonnet-5", { input_tokens: 10, output_tokens: 10 }) + "\n");
    recordAgentStop(root, transcript);
    appendFileSync(transcript, wrapped("claude-sonnet-5", { input_tokens: 5, output_tokens: 7 }) + "\n");
    const res = recordAgentStop(root, transcript);
    expect(res.records).toHaveLength(1);
    expect(res.records[0].inTokens).toBe(5);
    expect(res.records[0].outTokens).toBe(7);
  });

  it("handles a missing transcript without throwing", () => {
    const res = recordAgentStop(root, join(root, "nope.jsonl"));
    expect(res.records).toHaveLength(0);
    expect(res.note).toContain("not found");
  });
});

describe("usage summary source split", () => {
  it("splits dispatches and cost by source and formats the agent line", () => {
    const recs: DispatchRecord[] = [
      { at: "t", tier: "bulk", provider: "zai", model: "glm-5.2", role: "labor", exit: 0, costUsd: 0.01 },
      { at: "t", tier: "scoped", provider: "anthropic", model: "claude-sonnet-5", role: "judgment", exit: 0, costUsd: 1.5, source: "agent" },
    ];
    const s = summarizeUsage(recs);
    expect(s.bySource).toEqual({ cli: 1, agent: 1 });
    expect(s.costBySource.agent).toBeCloseTo(1.5);
    expect(formatUsage(s)).toContain("agent-tool");
  });
  it("omits the source line when no agent records exist", () => {
    const s = summarizeUsage([
      { at: "t", tier: "bulk", provider: "zai", model: "glm-5.2", role: "labor", exit: 0, costUsd: 0.01 },
    ]);
    expect(formatUsage(s)).not.toContain("agent-tool");
  });
});
