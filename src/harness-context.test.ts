import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compiledContextFor } from "./harness-context";
import { estimateTokens } from "./tokenizer";

const freshAnchor = (): string => mkdtempSync(join(tmpdir(), "context-"));

const writeAgents = (anchor: string, content: string): void => {
  writeFileSync(join(anchor, "AGENTS.md"), content);
};

describe("compiledContextFor", () => {
  it("missing AGENTS.md -> empty context, never throws", () => {
    const anchor = freshAnchor();
    expect(compiledContextFor(anchor)).toEqual({ text: "", tokens: 0, truncated: false, sources: [] });
  });

  it("small file within budget -> returned whole, exact text, not truncated", () => {
    const anchor = freshAnchor();
    const content = "hello world\n\nsecond paragraph";
    writeAgents(anchor, content);
    const result = compiledContextFor(anchor, 100);
    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
    expect(result.tokens).toBe(estimateTokens(content));
    expect(result.sources).toEqual(["AGENTS.md"]);
  });

  it("truncation preserves BOTH edges and elides the middle (prompt-design P4)", () => {
    const anchor = freshAnchor();
    // Ten 100-char paragraphs (~25 tokens each, ~250 total); a 130-token budget
    // forces truncation with room for a head slice, the marker, and a tail slice.
    const paragraphs = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i).repeat(100));
    writeAgents(anchor, paragraphs.join("\n\n"));

    const result = compiledContextFor(anchor, 130);
    expect(result.truncated).toBe(true);
    // Head preserved: opens with the first paragraph.
    expect(result.text.startsWith(paragraphs[0])).toBe(true);
    // Tail preserved: closes with the LAST paragraph -- the old tail-first cut
    // amputated exactly this highest-compliance slot.
    expect(result.text.endsWith(paragraphs[9])).toBe(true);
    // The middle is the sacrifice zone, and the elision is marked, not silent.
    expect(result.text).toContain("elided here for the context budget");
    expect(result.tokens).toBeLessThanOrEqual(130);
    expect(result.tokens).toBe(estimateTokens(result.text));
    // No partial paragraphs: every paragraph present appears in full.
    for (const p of paragraphs) {
      const present = result.text.includes(p);
      if (present) expect(result.text.split(p).length).toBe(2);
    }
    expect(result.sources).toEqual(["AGENTS.md"]);
  });

  it("a budget too tight for both edges keeps the head slice alone (primacy wins)", () => {
    const anchor = freshAnchor();
    const p1 = "a".repeat(100);
    const p2 = "b".repeat(100);
    const p3 = "c".repeat(100);
    writeAgents(anchor, [p1, p2, p3].join("\n\n"));

    // ~25-token budget: head fits one paragraph, no room for marker + tail.
    const result = compiledContextFor(anchor, 25);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(p1);
    expect(result.text).not.toContain("elided");
    expect(result.sources).toEqual(["AGENTS.md"]);
  });

  it("keeps at least the first paragraph even when it alone exceeds the budget", () => {
    const anchor = freshAnchor();
    const p1 = "x".repeat(1000);
    const p2 = "y".repeat(1000);
    const content = [p1, p2].join("\n\n");
    writeAgents(anchor, content);

    const result = compiledContextFor(anchor, 10);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe(p1);
    expect(result.tokens).toBeGreaterThan(10);
    expect(result.sources).toEqual(["AGENTS.md"]);
  });

  it("default budget is applied when budgetTokens is omitted", () => {
    const anchor = freshAnchor();
    const content = "short file";
    writeAgents(anchor, content);
    const result = compiledContextFor(anchor);
    expect(result.text).toBe(content);
    expect(result.truncated).toBe(false);
  });
});
