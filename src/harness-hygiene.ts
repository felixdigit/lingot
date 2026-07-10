import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { detectWorktree } from "./registry";

/**
 * Git hygiene lens (Order K). A pure, injectable-git, never-throws reporter
 * over one repo's branch/worktree/main state -- the tail of the agent
 * lifecycle (background worktree finishes -> merged -> prune) that nothing
 * automates today. Read-only: this module never mutates git state. The
 * companion mutator is `harness tidy` (harness-cli.ts), which uses only
 * `git branch -d` (never `-D`) and `git worktree prune`.
 *
 * `detectWorktree` in registry.ts answers the complementary question (is
 * THIS directory a worktree of some other repo, read from the worktree's own
 * `.git` file) used to classify strays during a `~/work` sweep. This module
 * answers the opposite direction -- from the repo's own admin data (`git
 * worktree list --porcelain`), which of its registered worktrees are still
 * live on disk, and which branches they hold.
 */

export type ExecFn = (cmd: string, args: string[], cwd: string) => string;

export interface HygieneReport {
  readonly branches: { total: number; mergedPrunable: string[]; goneUpstream: string[] };
  readonly worktrees: { total: number; orphaned: string[] };
  readonly main: { behind: number; unpushed: number };
  readonly current: string;
  readonly note?: string;
}

const DEFAULT_PROTECTED = ["main", "master", "release/*"];

function defaultExec(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Never throws: any git failure yields undefined so callers degrade to zeros/empties. */
function safeGit(execFn: ExecFn, args: string[], cwd: string): string | undefined {
  try {
    return execFn("git", args, cwd);
  } catch {
    return undefined;
  }
}

function isProtectedName(name: string, protectedList: readonly string[]): boolean {
  return protectedList.some((p) => (p.endsWith("/*") ? name.startsWith(p.slice(0, -1)) : name === p));
}

interface WorktreeEntry {
  readonly path: string;
  readonly branch?: string; // undefined = detached / bare
}

/** Parse `git worktree list --porcelain` blank-line-delimited records. */
function parseWorktrees(raw: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let branch: string | undefined;
  const flush = () => {
    if (path) entries.push({ path, ...(branch ? { branch } : {}) });
    path = undefined;
    branch = undefined;
  };
  for (const line of raw.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      const ref = line.slice("branch ".length).trim();
      branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
    } else if (line.trim() === "") {
      flush();
    }
  }
  flush();
  return entries;
}

/** Parse `git branch --merged main --format=%(refname:short)`. */
function parseMerged(raw: string): string[] {
  return raw.split("\n").map((l) => l.trim()).filter(Boolean);
}

/** Parse `git branch -vv` for `: gone]` upstream markers. */
function parseGone(raw: string): string[] {
  const names: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes(": gone]")) continue;
    const name = line.replace(/^\*?\s*/, "").split(/\s+/)[0];
    if (name) names.push(name);
  }
  return names;
}

/**
 * Report branch/worktree/main hygiene for the repo at `repoRoot`. Never
 * throws -- any underlying git failure degrades that section to zeros/empties
 * rather than propagating. `execFn` is injectable for tests; `opts.protected`
 * overrides the default protected-branch list (`main`, `master`, `release/*`).
 */
export function gitHygiene(
  repoRoot: string,
  opts?: { execFn?: ExecFn; protected?: readonly string[] },
): HygieneReport {
  const execFn = opts?.execFn ?? defaultExec;
  const protectedList = opts?.protected ?? DEFAULT_PROTECTED;

  const current = safeGit(execFn, ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot) ?? "";

  const worktreeRaw = safeGit(execFn, ["worktree", "list", "--porcelain"], repoRoot) ?? "";
  // Recover a missing branch (porcelain omitted it, e.g. an older git) from the
  // worktree's own .git file when the dir is live -- the direction detectWorktree
  // (registry.ts) already reads for stray classification during a `~/work` sweep.
  const worktreeEntries = parseWorktrees(worktreeRaw).map((w) => {
    if (w.branch || !existsSync(w.path)) return w;
    const detected = detectWorktree(w.path);
    return detected ? { ...w, branch: detected.branch } : w;
  });
  const worktreeHeldBranches = new Set(worktreeEntries.map((w) => w.branch).filter((b): b is string => !!b));
  const orphaned = worktreeEntries.filter((w) => !existsSync(w.path)).map((w) => w.path);

  const excluded = (name: string): boolean =>
    name === "main" || name === current || isProtectedName(name, protectedList) || worktreeHeldBranches.has(name);

  const mergedRaw = safeGit(execFn, ["branch", "--merged", "main", "--format=%(refname:short)"], repoRoot);
  const mergedPrunable = mergedRaw ? parseMerged(mergedRaw).filter((b) => !excluded(b)) : [];

  const vvRaw = safeGit(execFn, ["branch", "-vv"], repoRoot);
  const goneUpstream = vvRaw ? parseGone(vvRaw).filter((b) => !excluded(b)) : [];

  const allBranchesRaw = safeGit(execFn, ["branch", "--format=%(refname:short)"], repoRoot);
  const totalBranches = allBranchesRaw ? allBranchesRaw.split("\n").map((l) => l.trim()).filter(Boolean).length : 0;

  let behind = 0;
  let unpushed = 0;
  const hasUpstream = safeGit(execFn, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], repoRoot);
  if (hasUpstream) {
    const behindRaw = safeGit(execFn, ["rev-list", "--count", "HEAD..@{u}"], repoRoot);
    const unpushedRaw = safeGit(execFn, ["rev-list", "--count", "@{u}..HEAD"], repoRoot);
    behind = behindRaw ? parseInt(behindRaw, 10) || 0 : 0;
    unpushed = unpushedRaw ? parseInt(unpushedRaw, 10) || 0 : 0;
  }

  return {
    branches: { total: totalBranches, mergedPrunable, goneUpstream },
    worktrees: { total: worktreeEntries.length, orphaned },
    main: { behind, unpushed },
    current,
    note: "behind/unpushed reflect the last `git fetch` (no network call from the reporter)",
  };
}

/** Threshold check shared by the doctor's HYGIENE concern -- see docs/harness/orders/order-K-git-hygiene.md. */
export function hygieneTripped(r: HygieneReport): boolean {
  return (
    r.branches.mergedPrunable.length > 10 ||
    r.branches.goneUpstream.length > 0 ||
    r.worktrees.orphaned.length > 0 ||
    r.main.unpushed > 0 ||
    r.main.behind > 20
  );
}

/** One informational line, e.g. "HYGIENE yellow: 47 merged branches prunable, 2 orphaned worktrees, main 3 unpushed -- `harness tidy --dry`". */
export function formatHygieneLine(r: HygieneReport): string | undefined {
  if (!hygieneTripped(r)) return undefined;
  const parts: string[] = [];
  if (r.branches.mergedPrunable.length > 10) parts.push(`${r.branches.mergedPrunable.length} merged branches prunable`);
  if (r.branches.goneUpstream.length > 0) parts.push(`${r.branches.goneUpstream.length} gone-upstream branches`);
  if (r.worktrees.orphaned.length > 0) parts.push(`${r.worktrees.orphaned.length} orphaned worktrees`);
  if (r.main.unpushed > 0) parts.push(`main ${r.main.unpushed} unpushed`);
  if (r.main.behind > 20) parts.push(`main ${r.main.behind} behind`);
  return `HYGIENE yellow: ${parts.join(", ")} -- \`harness tidy --dry\``;
}

// ---------------------------------------------------------------- tidy

export interface TidyResult {
  readonly dryRun: boolean;
  readonly candidates: string[];
  readonly deleted: string[];
  readonly refused: { branch: string; reason: string }[];
  readonly worktreesPruned: boolean;
}

/**
 * The SAFE janitor: dry-run by default, `--apply` attempts only `git branch
 * -d` (never `-D`) on the candidate set + `git worktree prune`. Git's own
 * `-d` refusal of unmerged branches is the safety floor -- a wrong candidate
 * cannot lose unmerged work, it lands in `refused[]` instead of `deleted[]`.
 * Never touches main/current/protected/worktree-held branches or live
 * worktrees.
 */
export function tidy(
  repoRoot: string,
  opts?: { execFn?: ExecFn; protected?: readonly string[]; apply?: boolean; includeGone?: boolean },
): TidyResult {
  const execFn = opts?.execFn ?? defaultExec;
  const report = gitHygiene(repoRoot, { execFn, protected: opts?.protected });
  const candidates = [
    ...report.branches.mergedPrunable,
    ...(opts?.includeGone ? report.branches.goneUpstream.filter((b) => !report.branches.mergedPrunable.includes(b)) : []),
  ];

  if (!opts?.apply) {
    return { dryRun: true, candidates, deleted: [], refused: [], worktreesPruned: false };
  }

  const deleted: string[] = [];
  const refused: { branch: string; reason: string }[] = [];
  for (const branch of candidates) {
    try {
      execFn("git", ["branch", "-d", branch], repoRoot);
      deleted.push(branch);
    } catch (e) {
      refused.push({ branch, reason: (e as Error).message });
    }
  }
  let worktreesPruned = false;
  try {
    execFn("git", ["worktree", "prune"], repoRoot);
    worktreesPruned = true;
  } catch {
    worktreesPruned = false;
  }
  return { dryRun: false, candidates, deleted, refused, worktreesPruned };
}

export function formatTidyResult(r: TidyResult): string {
  const lines: string[] = [];
  if (r.dryRun) {
    lines.push(
      r.candidates.length > 0
        ? `harness tidy (dry-run): would prune ${r.candidates.length} branch(es): ${r.candidates.join(", ")}`
        : "harness tidy (dry-run): nothing to prune",
    );
    lines.push("run with --apply to execute (git branch -d + git worktree prune only)");
    return lines.join("\n");
  }
  lines.push(`harness tidy: deleted ${r.deleted.length}/${r.candidates.length} branch(es)${r.deleted.length ? `: ${r.deleted.join(", ")}` : ""}`);
  if (r.refused.length > 0) {
    lines.push(`  refused (kept -- git's -d safety floor): ${r.refused.map((x) => x.branch).join(", ")}`);
  }
  lines.push(`  git worktree prune: ${r.worktreesPruned ? "ok" : "failed"}`);
  return lines.join("\n");
}
