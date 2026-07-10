import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * The mtime-scoped artefact detector (Order I). A run may produce new images/PDFs
 * (renders, screenshots, generated reports); we want to auto-post those, but the
 * repo also carries many pre-existing UNCOMMITTED images (design-pass PNGs and
 * the like) that `git status --porcelain` alone would wrongly surface. Detection
 * is therefore the INTERSECTION of (a) git-status-changed paths and (b) files
 * whose mtime is at or after the run's start time -- a file that predates the run
 * can never pass (b), no matter how long it's sat uncommitted. Never throws: a
 * `git` failure (not a repo, git missing) yields an empty list, not an error.
 */

export interface ArtefactOpts {
  /** Max artefacts returned. Default 5 -- excess is dropped with a logged note (no silent truncation). */
  readonly cap?: number;
  /** Extensions considered artefacts (no leading dot, lowercase). Default png/jpg/jpeg/gif/svg/webp/pdf. */
  readonly exts?: readonly string[];
  readonly execFileFn?: (cmd: string, args: string[], opts: { cwd: string }) => string;
  readonly statFn?: (path: string) => { mtimeMs: number };
}

const DEFAULT_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "pdf"] as const;
const DEFAULT_CAP = 5;

/** Parse one `git status --porcelain` line to its (post-rename) path, or null if unparseable. */
function parsePorcelainPath(line: string): string | null {
  if (line.length < 4) return null;
  let rest = line.slice(3);
  if (rest.includes(" -> ")) rest = rest.slice(rest.indexOf(" -> ") + 4);
  if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
  return rest.trim() || null;
}

/**
 * Files that are BOTH git-status-changed AND written at/after `sinceMs`, filtered
 * to `opts.exts`, capped to `opts.cap`. Returns absolute paths (joined against
 * `repoRoot`). `sinceMs` should be the run's `Date.now()` recorded before the work
 * that might produce the artefact -- see `emitExecNotifications`.
 */
export function detectNewArtefacts(repoRoot: string, sinceMs: number, opts?: ArtefactOpts): string[] {
  const exts = new Set((opts?.exts ?? DEFAULT_EXTS).map((e) => e.toLowerCase()));
  const cap = opts?.cap ?? DEFAULT_CAP;
  const execFileFn = opts?.execFileFn ?? ((cmd, args, o) => execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8" }) as unknown as string);
  const statFn = opts?.statFn ?? ((p) => statSync(p));

  let out: string;
  try {
    out = execFileFn("git", ["status", "--porcelain"], { cwd: repoRoot });
  } catch {
    return [];
  }

  const changed: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const rel = parsePorcelainPath(line);
    if (!rel) continue;
    changed.push(rel);
  }

  const matched: string[] = [];
  for (const rel of changed) {
    const ext = extname(rel).slice(1).toLowerCase();
    if (!exts.has(ext)) continue;
    const abs = join(repoRoot, rel);
    try {
      if (statFn(abs).mtimeMs >= sinceMs) matched.push(abs);
    } catch {
      // deleted / unreadable -- not a postable artefact.
    }
  }

  if (matched.length > cap) {
    console.error(`harness-artefact: dropped ${matched.length - cap} artefact(s) past cap ${cap} (no silent truncation)`);
  }
  return matched.slice(0, cap);
}
