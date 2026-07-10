import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { compileHarness, organicCounterpart, renderTemplate, loadKernel } from "./harness-compile";
import type { VentureManifest } from "./venture";

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel");
const DEFAULT_SKILLS = ["research", "verify", "craft", "artifact", "plan", "git"];

function freshManifest(overrides: Partial<VentureManifest> = {}): VentureManifest {
  return {
    manifest: "lingot/v0",
    identity: { name: "testventure", kind: "venture", owners: ["felix"] },
    harness: { kernel: null, modules: {} },
    state: {},
    interfaces: { provides: [], consumes: [] },
    ...overrides,
  };
}

const freshDirs = (): { anchor: string; outDir: string } => ({
  anchor: mkdtempSync(join(tmpdir(), "compile-anchor-")),
  outDir: mkdtempSync(join(tmpdir(), "compile-out-")),
});

describe("compileHarness -- boot (regression: must keep compiling exactly as today)", () => {
  it("emits skills/boot.md rendered from kernel.templates.boot, identical to the pre-existing behavior", () => {
    const { anchor, outDir } = freshDirs();
    const manifest = freshManifest();
    const result = compileHarness(manifest, anchor, outDir);

    expect(result.files).toContain("skills/boot.md");
    const kernel = loadKernel();
    const expected = renderTemplate(readFileSync(join(KERNEL_DIR, kernel.templates.boot), "utf8"), {
      name: "testventure",
      title: "Testventure",
      founder: "Felix",
      aliases: {},
      overlay: {},
      state: {},
      modules: {},
      db: undefined,
      dbProject: undefined,
      gateWallList: "",
    });
    expect(readFileSync(join(outDir, "skills/boot.md"), "utf8")).toBe(expected);
  });

  it("still emits CLAUDE.base.md and compiled.json alongside boot", () => {
    const { anchor, outDir } = freshDirs();
    const result = compileHarness(freshManifest(), anchor, outDir);
    expect(result.files).toContain("CLAUDE.base.md");
    expect(result.files).toContain("compiled.json");
  });
});

describe("compileHarness -- default skill pack (research/verify/craft/artifact/plan/git)", () => {
  it("emits every kernel.defaultSkills entry as skills/<name>.md, rendered through the same ctx as boot", () => {
    const { anchor, outDir } = freshDirs();
    const result = compileHarness(freshManifest(), anchor, outDir);

    for (const name of DEFAULT_SKILLS) {
      expect(result.files).toContain(`skills/${name}.md`);
      const expected = renderTemplate(readFileSync(join(KERNEL_DIR, "skills", `${name}.md`), "utf8"), {
        name: "testventure",
        title: "Testventure",
        founder: "Felix",
        aliases: {},
        overlay: {},
        state: {},
        modules: {},
        db: undefined,
        dbProject: undefined,
        gateWallList: "",
      });
      expect(readFileSync(join(outDir, `skills/${name}.md`), "utf8")).toBe(expected);
    }
  });

  it("kernel.json actually declares the six default skills (not just this test's own list)", () => {
    const kernel = loadKernel();
    expect(kernel.defaultSkills).toEqual(DEFAULT_SKILLS);
  });
});

describe("compileHarness -- manifest-declared venture skills", () => {
  it("emits a venture skill named after its source file", () => {
    const { anchor, outDir } = freshDirs();
    mkdirSync(join(anchor, "docs", "skills"), { recursive: true });
    writeFileSync(join(anchor, "docs", "skills", "pricing.md"), "---\nname: pricing\ndescription: d\n---\n\nBody for {{name}}.\n");

    const manifest = freshManifest({ skills: ["docs/skills/pricing.md"] });
    const result = compileHarness(manifest, anchor, outDir);

    expect(result.files).toContain("skills/pricing.md");
    expect(readFileSync(join(outDir, "skills/pricing.md"), "utf8")).toBe("---\nname: pricing\ndescription: d\n---\n\nBody for testventure.\n");
  });

  it("expands a single-* glob entry to every matched source", () => {
    const { anchor, outDir } = freshDirs();
    mkdirSync(join(anchor, "docs", "skills"), { recursive: true });
    writeFileSync(join(anchor, "docs", "skills", "a.md"), "A for {{name}}");
    writeFileSync(join(anchor, "docs", "skills", "b.md"), "B for {{name}}");

    const manifest = freshManifest({ skills: ["docs/skills/*.md"] });
    const result = compileHarness(manifest, anchor, outDir);

    expect(result.files).toContain("skills/a.md");
    expect(result.files).toContain("skills/b.md");
    expect(readFileSync(join(outDir, "skills/a.md"), "utf8")).toBe("A for testventure");
    expect(readFileSync(join(outDir, "skills/b.md"), "utf8")).toBe("B for testventure");
  });

  it("never throws on a missing venture-skill source -- skips it instead", () => {
    const { anchor, outDir } = freshDirs();
    const manifest = freshManifest({ skills: ["docs/skills/does-not-exist.md"] });

    expect(() => compileHarness(manifest, anchor, outDir)).not.toThrow();
    const result = compileHarness(manifest, anchor, outDir);
    expect(result.files).not.toContain("skills/does-not-exist.md");
    expect(existsSync(join(outDir, "skills/does-not-exist.md"))).toBe(false);
  });

  it("a venture with no skills declared compiles exactly the default set (no extras, no crash)", () => {
    const { anchor, outDir } = freshDirs();
    const result = compileHarness(freshManifest(), anchor, outDir);
    const skillFiles = result.files.filter((f) => f.startsWith("skills/"));
    expect(skillFiles.sort()).toEqual(["skills/artifact.md", "skills/boot.md", "skills/craft.md", "skills/git.md", "skills/plan.md", "skills/research.md", "skills/verify.md"].sort());
  });
});

describe("organicCounterpart -- the generalized adopter path-map", () => {
  it("maps skills/boot.md -> .claude/skills/boot/SKILL.md (unchanged behavior)", () => {
    const anchor = mkdtempSync(join(tmpdir(), "adopt-anchor-"));
    mkdirSync(join(anchor, ".claude", "skills", "boot"), { recursive: true });
    writeFileSync(join(anchor, ".claude", "skills", "boot", "SKILL.md"), "boot organic");

    expect(organicCounterpart(anchor, "skills/boot.md")).toBe(join(anchor, ".claude", "skills", "boot", "SKILL.md"));
  });

  it("maps skills/<non-boot-name>.md -> .claude/skills/<name>/SKILL.md", () => {
    const anchor = mkdtempSync(join(tmpdir(), "adopt-anchor-"));
    mkdirSync(join(anchor, ".claude", "skills", "research"), { recursive: true });
    writeFileSync(join(anchor, ".claude", "skills", "research", "SKILL.md"), "research organic");

    expect(organicCounterpart(anchor, "skills/research.md")).toBe(join(anchor, ".claude", "skills", "research", "SKILL.md"));
  });

  it("returns null when no organic counterpart exists on disk yet", () => {
    const anchor = mkdtempSync(join(tmpdir(), "adopt-anchor-"));
    expect(organicCounterpart(anchor, "skills/craft.md")).toBeNull();
  });
});
