import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHygiene, hygieneTripped, formatHygieneLine, tidy, type ExecFn } from "./harness-hygiene";

const REPO = "/fake/repo";
// gitHygiene checks worktree *paths* against the real filesystem (existsSync),
// so orphaned-vs-live assertions need a genuinely-existing dir (tmpdir()) and a
// genuinely-missing one -- the repo cwd itself (REPO) is never fs-checked.
const LIVE_DIR = tmpdir();
const MISSING_DIR = join(tmpdir(), "harness-hygiene-test-missing-xyz-does-not-exist");

/** Build a fake execFn from a map of "cmd args..." (joined) -> canned stdout, with optional throwers. */
function fakeExec(responses: Record<string, string>, throwers: Record<string, string> = {}): ExecFn {
  return (cmd, args) => {
    const key = args.join(" ");
    if (key in throwers) throw new Error(throwers[key]);
    if (key in responses) return responses[key];
    throw new Error(`fakeExec: no canned response for "${cmd} ${key}"`);
  };
}

const WORKTREE_LIST = [
  `worktree ${LIVE_DIR}`,
  "HEAD 1111111",
  "branch refs/heads/main",
  "",
  `worktree ${LIVE_DIR}`,
  "HEAD 2222222",
  "branch refs/heads/agent/live-branch",
  "",
  `worktree ${MISSING_DIR}`,
  "HEAD 3333333",
  "branch refs/heads/agent/gone-dir",
  "",
].join("\n");

describe("gitHygiene", () => {
  it("excludes main, current, protected, and worktree-held branches from mergedPrunable", () => {
    const execFn = fakeExec({
      "rev-parse --abbrev-ref HEAD": "feature/current",
      "worktree list --porcelain": WORKTREE_LIST,
      "branch --merged main --format=%(refname:short)":
        "main\nfeature/current\nrelease/1.0\nagent/live-branch\nagent/dead-and-merged\n",
      "branch -vv": "  agent/dead-and-merged abc1234 [origin/agent/dead-and-merged] msg\n",
      "branch --format=%(refname:short)": "main\nfeature/current\nrelease/1.0\nagent/live-branch\nagent/dead-and-merged\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/feature/current",
      "rev-list --count HEAD..@{u}": "0",
      "rev-list --count @{u}..HEAD": "0",
    });
    const report = gitHygiene(REPO, { execFn });
    expect(report.branches.mergedPrunable).toEqual(["agent/dead-and-merged"]);
    expect(report.current).toBe("feature/current");
  });

  it("parses gone-upstream branches from `: gone]` markers, applying the same exclusions", () => {
    const execFn = fakeExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "worktree list --porcelain": WORKTREE_LIST,
      "branch --merged main --format=%(refname:short)": "main\n",
      "branch -vv": [
        "* main                 1111111 [origin/main] msg",
        "  agent/live-branch    2222222 [origin/agent/live-branch: gone] msg",
        "  agent/stale-gone     4444444 [origin/agent/stale-gone: gone] msg",
      ].join("\n"),
      "branch --format=%(refname:short)": "main\nagent/live-branch\nagent/stale-gone\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
      "rev-list --count HEAD..@{u}": "0",
      "rev-list --count @{u}..HEAD": "0",
    });
    const report = gitHygiene(REPO, { execFn });
    // agent/live-branch is excluded (worktree-held); agent/stale-gone survives.
    expect(report.branches.goneUpstream).toEqual(["agent/stale-gone"]);
  });

  it("detects orphaned worktrees (registered but the dir is missing on disk)", () => {
    const execFn = fakeExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "worktree list --porcelain": WORKTREE_LIST,
      "branch --merged main --format=%(refname:short)": "main\n",
      "branch -vv": "* main 1111111 [origin/main] msg\n",
      "branch --format=%(refname:short)": "main\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
      "rev-list --count HEAD..@{u}": "0",
      "rev-list --count @{u}..HEAD": "0",
    });
    const report = gitHygiene(REPO, { execFn });
    // LIVE_DIR (tmpdir()) exists; MISSING_DIR does not -- only the latter is orphaned.
    expect(report.worktrees.total).toBe(3);
    expect(report.worktrees.orphaned).toEqual([MISSING_DIR]);
  });

  it("computes behind/unpushed against the upstream ref", () => {
    const execFn = fakeExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "worktree list --porcelain": "worktree /fake/repo\nHEAD 1111111\nbranch refs/heads/main\n",
      "branch --merged main --format=%(refname:short)": "main\n",
      "branch -vv": "* main 1111111 [origin/main] msg\n",
      "branch --format=%(refname:short)": "main\n",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
      "rev-list --count HEAD..@{u}": "5",
      "rev-list --count @{u}..HEAD": "3",
    });
    const report = gitHygiene(REPO, { execFn });
    expect(report.main).toEqual({ behind: 5, unpushed: 3 });
  });

  it("never throws: any git failure degrades to zeros/empties", () => {
    const execFn: ExecFn = () => {
      throw new Error("git: command not found");
    };
    expect(() => gitHygiene(REPO, { execFn })).not.toThrow();
    const report = gitHygiene(REPO, { execFn });
    expect(report.branches).toEqual({ total: 0, mergedPrunable: [], goneUpstream: [] });
    expect(report.worktrees).toEqual({ total: 0, orphaned: [] });
    expect(report.main).toEqual({ behind: 0, unpushed: 0 });
    expect(report.current).toBe("");
  });

  it("has no upstream -> behind/unpushed stay 0, no throw", () => {
    const execFn = fakeExec(
      {
        "rev-parse --abbrev-ref HEAD": "main",
        "worktree list --porcelain": "worktree /fake/repo\nHEAD 1111111\nbranch refs/heads/main\n",
        "branch --merged main --format=%(refname:short)": "main\n",
        "branch -vv": "* main 1111111 msg\n",
        "branch --format=%(refname:short)": "main\n",
      },
      { "rev-parse --abbrev-ref --symbolic-full-name @{u}": "no upstream configured" },
    );
    const report = gitHygiene(REPO, { execFn });
    expect(report.main).toEqual({ behind: 0, unpushed: 0 });
  });
});

describe("hygieneTripped / formatHygieneLine", () => {
  it("is silent (no line) when clean", () => {
    const clean = gitHygiene(REPO, {
      execFn: fakeExec({
        "rev-parse --abbrev-ref HEAD": "main",
        "worktree list --porcelain": `worktree ${LIVE_DIR}\nHEAD 1111111\nbranch refs/heads/main\n`,
        "branch --merged main --format=%(refname:short)": "main\n",
        "branch -vv": "* main 1111111 [origin/main] msg\n",
        "branch --format=%(refname:short)": "main\n",
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
        "rev-list --count HEAD..@{u}": "0",
        "rev-list --count @{u}..HEAD": "0",
      }),
    });
    expect(hygieneTripped(clean)).toBe(false);
    expect(formatHygieneLine(clean)).toBeUndefined();
  });

  it("trips yellow (never red -- this module has no concept of red) when thresholds are crossed", () => {
    const dirty: Parameters<typeof formatHygieneLine>[0] = {
      branches: { total: 60, mergedPrunable: Array.from({ length: 47 }, (_, i) => `b${i}`), goneUpstream: [] },
      worktrees: { total: 3, orphaned: ["/fake/worktrees/gone-dir", "/fake/worktrees/other-gone"] },
      main: { behind: 0, unpushed: 3 },
      current: "main",
    };
    expect(hygieneTripped(dirty)).toBe(true);
    const line = formatHygieneLine(dirty);
    expect(line).toContain("HYGIENE yellow");
    expect(line).toContain("47 merged branches prunable");
    expect(line).toContain("2 orphaned worktrees");
    expect(line).toContain("main 3 unpushed");
    expect(line).toContain("harness tidy --dry");
  });
});

describe("tidy", () => {
  const CLEAN_BASE = {
    "rev-parse --abbrev-ref HEAD": "main",
    "worktree list --porcelain": "worktree /fake/repo\nHEAD 1111111\nbranch refs/heads/main\n",
    "branch -vv": "* main 1111111 [origin/main] msg\n",
    "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/main",
    "rev-list --count HEAD..@{u}": "0",
    "rev-list --count @{u}..HEAD": "0",
  };

  it("dry-run lists the prunable set and calls no mutating git command", () => {
    const calls: string[] = [];
    const base = fakeExec({
      ...CLEAN_BASE,
      "branch --merged main --format=%(refname:short)": "main\nagent/old-merged\n",
      "branch --format=%(refname:short)": "main\nagent/old-merged\n",
    });
    const execFn: ExecFn = (cmd, args, cwd) => {
      calls.push(args.join(" "));
      return base(cmd, args, cwd);
    };
    const result = tidy(REPO, { execFn });
    expect(result.dryRun).toBe(true);
    expect(result.candidates).toEqual(["agent/old-merged"]);
    expect(result.deleted).toEqual([]);
    expect(calls.some((c) => c.startsWith("branch -d") || c.startsWith("branch -D") || c === "worktree prune")).toBe(false);
  });

  it("a fake -d that refuses an unmerged branch lands in refused[], not deleted[]", () => {
    const base = fakeExec({
      ...CLEAN_BASE,
      "branch --merged main --format=%(refname:short)": "main\nagent/actually-merged\nagent/looks-merged-but-isnt\n",
      "branch --format=%(refname:short)": "main\nagent/actually-merged\nagent/looks-merged-but-isnt\n",
      "worktree prune": "",
    });
    const execFn: ExecFn = (cmd, args, cwd) => {
      if (args[0] === "branch" && args[1] === "-d" && args[2] === "agent/looks-merged-but-isnt") {
        throw new Error("error: the branch 'agent/looks-merged-but-isnt' is not fully merged");
      }
      if (args[0] === "branch" && args[1] === "-d") return "Deleted branch " + args[2];
      return base(cmd, args, cwd);
    };
    const result = tidy(REPO, { execFn, apply: true });
    expect(result.deleted).toEqual(["agent/actually-merged"]);
    expect(result.refused.map((r) => r.branch)).toEqual(["agent/looks-merged-but-isnt"]);
    expect(result.worktreesPruned).toBe(true);
  });

  it("never proposes main or current as prune candidates", () => {
    const execFn = fakeExec({
      ...CLEAN_BASE,
      "rev-parse --abbrev-ref HEAD": "release/1.0",
      "branch --merged main --format=%(refname:short)": "main\nrelease/1.0\nagent/mergeable\n",
      "branch --format=%(refname:short)": "main\nrelease/1.0\nagent/mergeable\n",
    });
    const result = tidy(REPO, { execFn });
    expect(result.candidates).not.toContain("main");
    expect(result.candidates).not.toContain("release/1.0");
    expect(result.candidates).toEqual(["agent/mergeable"]);
  });

  it("--apply never uses git branch -D", () => {
    const dCalls: string[] = [];
    const base = fakeExec({
      ...CLEAN_BASE,
      "branch --merged main --format=%(refname:short)": "main\nagent/mergeable\n",
      "branch --format=%(refname:short)": "main\nagent/mergeable\n",
      "worktree prune": "",
    });
    const execFn: ExecFn = (cmd, args, cwd) => {
      if (args[0] === "branch") dCalls.push(args[1]);
      if (args[0] === "branch" && args[1] === "-d") return "Deleted branch " + args[2];
      return base(cmd, args, cwd);
    };
    tidy(REPO, { execFn, apply: true });
    const mutatingFlags = dCalls.filter((flag) => flag === "-d" || flag === "-D");
    expect(mutatingFlags).not.toContain("-D");
    expect(mutatingFlags).toEqual(["-d"]);
  });
});
