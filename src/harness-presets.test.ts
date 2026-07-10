import { describe, it, expect } from "vitest";
import { expandToolPresets } from "./harness-kernel";

describe("tool presets (harness exec --tools <preset>)", () => {
  it("research expands to include ToolSearch + the web tools (the deferred-tool gotcha fix)", () => {
    const t = expandToolPresets(["research"]);
    expect(t).toContain("ToolSearch");
    expect(t).toContain("WebSearch");
    expect(t).toContain("WebFetch");
    expect(t).toContain("Read");
  });

  it("mixes a preset with an explicit tool, deduped + order-stable", () => {
    const t = expandToolPresets(["research", "Bash"]);
    expect(t).toContain("Bash");
    expect(t.filter((x) => x === "Read").length).toBe(1);
  });

  it("passes a plain tool list through unchanged", () => {
    expect(expandToolPresets(["Read", "Write"])).toEqual(["Read", "Write"]);
  });

  it("build has Write/Edit/Bash; read stays read-only", () => {
    expect(expandToolPresets(["build"])).toEqual(expect.arrayContaining(["Write", "Edit", "Bash"]));
    expect(expandToolPresets(["read"])).not.toContain("Bash");
  });
});
