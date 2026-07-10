import { describe, it, expect, vi } from "vitest";
import { detectNewArtefacts } from "./harness-artefact";

const REPO = "/repo";
const SINCE = 1_000_000;

function fakeStat(mtimes: Record<string, number>) {
  return (path: string) => {
    const key = Object.keys(mtimes).find((k) => path.endsWith(k));
    if (key === undefined) throw new Error(`ENOENT: ${path}`);
    return { mtimeMs: mtimes[key] };
  };
}

describe("detectNewArtefacts", () => {
  it("intersects git-status-changed with mtime >= sinceMs -- an old-mtime changed image is EXCLUDED", () => {
    const execFileFn = vi.fn().mockReturnValue(" M design-pass/old-shot.png\n?? renders/fresh-shot.png\n");
    const statFn = fakeStat({
      "design-pass/old-shot.png": SINCE - 5000, // pre-existing, uncommitted -- must NOT post
      "renders/fresh-shot.png": SINCE + 5000, // written during the run -- must post
    });
    const result = detectNewArtefacts(REPO, SINCE, { execFileFn, statFn });
    expect(result).toEqual([`${REPO}/renders/fresh-shot.png`]);
  });

  it("a fresh-mtime file is INCLUDED", () => {
    const execFileFn = vi.fn().mockReturnValue("?? out/hero.png\n");
    const statFn = fakeStat({ "out/hero.png": SINCE + 1 });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([`${REPO}/out/hero.png`]);
  });

  it("mtime exactly at sinceMs counts as included (>=)", () => {
    const execFileFn = vi.fn().mockReturnValue("?? out/hero.png\n");
    const statFn = fakeStat({ "out/hero.png": SINCE });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([`${REPO}/out/hero.png`]);
  });

  it("filters by extension -- a fresh non-artefact file (e.g. .ts) is excluded", () => {
    const execFileFn = vi.fn().mockReturnValue("?? src/harness-cli.ts\n?? out/hero.pdf\n");
    const statFn = fakeStat({ "src/harness-cli.ts": SINCE + 1, "out/hero.pdf": SINCE + 1 });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([`${REPO}/out/hero.pdf`]);
  });

  it("respects a custom ext list", () => {
    const execFileFn = vi.fn().mockReturnValue("?? out/data.csv\n");
    const statFn = fakeStat({ "out/data.csv": SINCE + 1 });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn, exts: ["csv"] })).toEqual([`${REPO}/out/data.csv`]);
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([]);
  });

  it("caps to opts.cap and logs a note, no silent truncation", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const files = Array.from({ length: 8 }, (_, i) => `?? out/img${i}.png`).join("\n") + "\n";
    const execFileFn = vi.fn().mockReturnValue(files);
    const mtimes = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`out/img${i}.png`, SINCE + 1]));
    const statFn = fakeStat(mtimes);
    const result = detectNewArtefacts(REPO, SINCE, { execFileFn, statFn, cap: 3 });
    expect(result).toHaveLength(3);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 5 artefact(s)"));
    errSpy.mockRestore();
  });

  it("default cap is 5", () => {
    const files = Array.from({ length: 7 }, (_, i) => `?? out/img${i}.png`).join("\n") + "\n";
    const execFileFn = vi.fn().mockReturnValue(files);
    const mtimes = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`out/img${i}.png`, SINCE + 1]));
    const statFn = fakeStat(mtimes);
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toHaveLength(5);
  });

  it("handles a rename line (R  old -> new), using the post-rename path", () => {
    const execFileFn = vi.fn().mockReturnValue("R  out/old.png -> out/new.png\n");
    const statFn = fakeStat({ "out/new.png": SINCE + 1 });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([`${REPO}/out/new.png`]);
  });

  it("a deleted (unstat-able) path is skipped, not thrown", () => {
    const execFileFn = vi.fn().mockReturnValue(" D out/gone.png\n");
    const statFn = vi.fn(() => {
      throw new Error("ENOENT");
    });
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn })).toEqual([]);
  });

  it("git failure -> empty list, never throws", () => {
    const execFileFn = vi.fn(() => {
      throw new Error("not a git repository");
    });
    expect(() => detectNewArtefacts(REPO, SINCE, { execFileFn })).not.toThrow();
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn })).toEqual([]);
  });

  it("blank lines and empty status output are ignored", () => {
    const execFileFn = vi.fn().mockReturnValue("\n\n");
    expect(detectNewArtefacts(REPO, SINCE, { execFileFn, statFn: fakeStat({}) })).toEqual([]);
  });
});
