import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lintKernelSources, lintAgentsMd, lintCompiledArtifact, formatLintFindings, type LintFinding } from "./harness-lint";

// Unicode targets built from escapes -- never a literal glyph in this test file
// either, for the same reason the library avoids one (harness-lint.ts).
const EM_DASH = "\u2014";
const NOT_EQUAL = "\u2260";
const RIGHT_ARROW = "\u2192";

/** A throwaway kernel dir (contract-base.md / pack-template.md / boot-skill.md + skills/), never the live kernel. */
function freshKernelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lint-kernel-"));
  mkdirSync(join(dir, "skills"), { recursive: true });
  return dir;
}

const DONE_OK = "# Some Unit\n\nBody text.\n\n## Done = reviewable\n\nParks at review.\n";
const DONE_MISSING = "# Some Unit\n\nBody text with no contract.\n";

describe("lintKernelSources -- em-dash (the house bans U+2014 everywhere)", () => {
  it("flags a line carrying em dashes, naming the count on that line", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), `first line\na line with ${EM_DASH} one dash and ${EM_DASH} two.\nthird line\n`);
    const findings = lintKernelSources(dir).filter((x) => x.rule === "em-dash");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "pack-template.md", line: 2, severity: "error" });
    expect(findings[0].detail).toBe("2 em dash(es) on this line");
  });

  it("a clean file reports no em-dash finding", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), DONE_OK);
    expect(lintKernelSources(dir).filter((x) => x.rule === "em-dash")).toEqual([]);
  });
});

describe("lintKernelSources -- codec-symbol (ASCII != and -> are the canon)", () => {
  it("flags U+2260 and U+2192, each naming its ASCII replacement", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), `${NOT_EQUAL} on line one\n${RIGHT_ARROW} on line two\n`);
    const findings = lintKernelSources(dir).filter((x) => x.rule === "codec-symbol");
    expect(findings).toHaveLength(2);
    expect(findings.find((f) => f.line === 1)?.detail).toBe("use ASCII != (codec canon)");
    expect(findings.find((f) => f.line === 2)?.detail).toBe("use -> (codec canon)");
  });

  it("a clean file reports no codec-symbol finding", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), DONE_OK);
    expect(lintKernelSources(dir).filter((x) => x.rule === "codec-symbol")).toEqual([]);
  });
});

describe("lintKernelSources -- done-line (dispatched prompt units only, never contract-base)", () => {
  it("skills/*.md, pack-template.md, and boot-skill.md each need their own Done contract", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), DONE_MISSING);
    writeFileSync(join(dir, "boot-skill.md"), DONE_MISSING);
    writeFileSync(join(dir, "skills", "research.md"), DONE_MISSING);
    const findings = lintKernelSources(dir).filter((x) => x.rule === "done-line");
    expect(findings.map((f) => f.file).sort()).toEqual(["boot-skill.md", "pack-template.md", "skills/research.md"]);
    for (const f of findings) {
      expect(f.line).toBe(1);
      expect(f.severity).toBe("error");
      expect(f.detail).toBe("prompt unit lacks a Done = contract");
    }
  });

  it("a present Done contract (a Done heading, or a bolded **Done**) clears the finding", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "pack-template.md"), DONE_OK);
    writeFileSync(join(dir, "boot-skill.md"), "# Boot\n\nBody.\n\n**Done** when the checklist is clear.\n");
    writeFileSync(join(dir, "skills", "research.md"), DONE_OK);
    expect(lintKernelSources(dir).filter((x) => x.rule === "done-line")).toEqual([]);
  });

  it("contract-base.md is never checked for a Done contract, even when it plainly lacks one", () => {
    const dir = freshKernelDir();
    writeFileSync(join(dir, "contract-base.md"), DONE_MISSING);
    const findings = lintKernelSources(dir);
    expect(findings.filter((x) => x.rule === "done-line" && x.file === "contract-base.md")).toEqual([]);
    // em-dash + codec-symbol still ran over it -- only done-line skips it.
    expect(findings.filter((x) => x.file === "contract-base.md")).toEqual([]);
  });
});

describe("lintAgentsMd -- front-desc (inside the \"## Fronts\" section only)", () => {
  it("warns on a bullet that names a front but carries an empty description", () => {
    const content = [
      "## Fronts -- the org chart (generated from the charters)",
      "- **Zone One** -- ",
      "- **Zone Two** -- shipped the thing",
    ].join("\n");
    const findings = lintAgentsMd("AGENTS.md", content).filter((x) => x.rule === "front-desc");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "AGENTS.md", line: 2, severity: "warn", detail: "front has empty description" });
  });

  it("stays silent when every front bullet carries a description", () => {
    const content = [
      "## Fronts -- the org chart (generated from the charters)",
      "- **Zone One** -- shipped the thing",
      "- **Zone Two** -- shipped another thing",
    ].join("\n");
    expect(lintAgentsMd("AGENTS.md", content).filter((x) => x.rule === "front-desc")).toEqual([]);
  });

  it("ignores the empty-bullet shape outside the Fronts section", () => {
    const content = ["## Model routing", "- **not a front** -- ", "", "## Fronts", "- **Zone** -- filled"].join("\n");
    expect(lintAgentsMd("AGENTS.md", content).filter((x) => x.rule === "front-desc")).toEqual([]);
  });
});

describe("lintCompiledArtifact -- hollow-slot", () => {
  it("catches an unresolved template slot", () => {
    const content = "line one\n<UNRESOLVED:name>\nline three\n";
    const findings = lintCompiledArtifact("AGENTS.md", content).filter((x) => x.rule === "hollow-slot");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, severity: "error", detail: "unresolved template slot" });
  });

  it("catches an unfilled overlay placeholder", () => {
    const content = "line one\nsee <PENDING OVERLAY CONTENT>\nline three\n";
    const findings = lintCompiledArtifact("AGENTS.md", content).filter((x) => x.rule === "hollow-slot");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ line: 2, severity: "error", detail: "unfilled overlay placeholder" });
  });

  it("a clean compiled artifact reports no hollow-slot finding", () => {
    expect(lintCompiledArtifact("AGENTS.md", "all filled in, nothing pending\n").filter((x) => x.rule === "hollow-slot")).toEqual([]);
  });
});

describe("lintCompiledArtifact -- done-line applies only to compiled zone packs (packs/zone-*.md)", () => {
  it("flags a compiled zone pack missing its Done contract", () => {
    const findings = lintCompiledArtifact("packs/zone-1-sales.md", DONE_MISSING).filter((x) => x.rule === "done-line");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ file: "packs/zone-1-sales.md", line: 1, severity: "error" });
  });

  it("a compiled zone pack that does carry a Done contract clears the finding", () => {
    expect(lintCompiledArtifact("packs/zone-1-sales.md", DONE_OK).filter((x) => x.rule === "done-line")).toEqual([]);
  });

  it("done-line does not apply to a non-zone-pack compiled artifact", () => {
    expect(lintCompiledArtifact("AGENTS.md", DONE_MISSING).filter((x) => x.rule === "done-line")).toEqual([]);
    expect(lintCompiledArtifact("skills/boot.md", DONE_MISSING).filter((x) => x.rule === "done-line")).toEqual([]);
  });
});

describe("formatLintFindings", () => {
  it("one line per finding, then a closing error/warning count", () => {
    const findings: LintFinding[] = [
      { rule: "em-dash", file: "a.md", line: 3, detail: "1 em dash(es) on this line", severity: "error" },
      { rule: "front-desc", file: "AGENTS.md", line: 7, detail: "front has empty description", severity: "warn" },
    ];
    const out = formatLintFindings(findings);
    const lines = out.split("\n");
    expect(lines[0]).toBe("  error em-dash a.md:3 1 em dash(es) on this line");
    expect(lines[1]).toBe("  warn front-desc AGENTS.md:7 front has empty description");
    expect(lines[2]).toBe("harness lint: 1 error(s), 1 warning(s)");
  });

  it("an empty finding set still prints the zero-count summary", () => {
    expect(formatLintFindings([])).toBe("harness lint: 0 error(s), 0 warning(s)");
  });
});
