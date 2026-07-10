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

  it("large file truncates on a paragraph boundary under budget, no partial paragraph", () => {
    const anchor = freshAnchor();
    const p1 = "a".repeat(100);
    const p2 = "b".repeat(100);
    const p3 = "c".repeat(100);
    const content = [p1, p2, p3].join("\n\n");
    writeAgents(anchor, content);

    expect(estimateTokens(content)).toBeGreaterThan(60);

    const result = compiledContextFor(anchor, 60);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe([p1, p2].join("\n\n"));
    expect(result.tokens).toBeLessThanOrEqual(60);
    expect(result.tokens).toBe(estimateTokens(result.text));
    // no partial paragraph: every kept paragraph appears in full
    expect(result.text).not.toContain(p3);
    expect(result.text.endsWith(p2)).toBe(true);
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
