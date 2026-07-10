import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitExecNotifications, emitRouteNotifications, emitDriftNotifications } from "./harness-notify-emit";

const withToken: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: "xoxb-test" };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function tmpManifest(notify?: { slack?: { worksite?: string; ops?: string; events?: string[] } }): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "harness-notify-emit-"));
  const manifest = {
    harness: "harness/v1",
    identity: { name: "agency", kind: "venture", owners: ["felix"] },
    kernel: { version: "~> 1.4" },
    ...(notify ? { notify } : {}),
  };
  const path = join(dir, "harness.json");
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return { dir, path };
}

describe("emitExecNotifications", () => {
  it("no notify block -> zero fetch calls (honest-skip)", async () => {
    const { path } = tmpManifest();
    const fetchFn = vi.fn();
    await emitExecNotifications(path, Date.now(), {
      exit: 0, heldOps: [], tier: "scoped", costUsd: 0.01, toolCalls: ["Read"], task: "t",
    }, { env: withToken, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("posts a dispatch to worksite", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "111.1", channel: "C_WORKSITE" }));
    await emitExecNotifications(path, Date.now(), {
      exit: 0, heldOps: [], tier: "scoped", costUsd: 0.01, toolCalls: ["Read"], task: "run the thing",
    }, { env: withToken, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_WORKSITE");
    expect(body.text).toContain("run the thing");
  });

  it("a heldOp posts gate-held to ops", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "111.1", channel: "C_WORKSITE" }));
    await emitExecNotifications(path, Date.now(), {
      exit: 0, heldOps: ["db-write"], tier: "scoped", costUsd: 0.01, toolCalls: [], task: "t",
    }, { env: withToken, fetchFn });
    // one dispatch call + one gate-held call
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const bodies = fetchFn.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    const held = bodies.find((b: any) => b.channel === "C_OPS");
    expect(held).toBeDefined();
    expect(held.text).toContain("db-write");
  });

  it("a fresh artefact is uploaded threaded under the dispatch ts; a pre-existing uncommitted image is NOT posted", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });

    // A real git repo (this exercises the actual execFileSync/statSync default path in
    // detectNewArtefacts end-to-end, not a stub) with both directories already tracked so
    // new files inside show individually in `git status --porcelain` rather than grouped.
    const repoRoot = mkdtempSync(join(tmpdir(), "harness-notify-emit-repo-"));
    execFileSync("git", ["init", "-q"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.email", "a@b.c"], { cwd: repoRoot });
    execFileSync("git", ["config", "user.name", "test"], { cwd: repoRoot });
    mkdirSync(join(repoRoot, "design-pass"), { recursive: true });
    mkdirSync(join(repoRoot, "renders"), { recursive: true });
    writeFileSync(join(repoRoot, "design-pass", ".gitkeep"), "");
    writeFileSync(join(repoRoot, "renders", ".gitkeep"), "");
    execFileSync("git", ["add", "."], { cwd: repoRoot });
    execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repoRoot });

    // A pre-existing uncommitted image (like the many design-pass PNGs already in the tree)
    // written and backdated BEFORE the run's startMs.
    const oldFile = join(repoRoot, "design-pass", "pre-existing.png");
    writeFileSync(oldFile, "old-bytes");
    const past = new Date(Date.now() - 60_000);
    utimesSync(oldFile, past, past);

    const startMs = Date.now();

    // A fresh artefact produced by the "run", written strictly AFTER startMs.
    const freshFile = join(repoRoot, "renders", "fresh.png");
    writeFileSync(freshFile, "fresh-bytes");

    // notify's dispatch call resolves ts; upload calls follow the 3-step external-upload flow.
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("chat.postMessage")) return jsonResponse({ ok: true, ts: "222.2", channel: "C_WORKSITE" });
      if (url.includes("getUploadURLExternal")) return jsonResponse({ ok: true, upload_url: "https://upload.example/x", file_id: "F1" });
      if (url.includes("upload.example")) return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
      if (url.includes("completeUploadExternal")) return jsonResponse({ ok: true });
      throw new Error(`unexpected fetch: ${url}`);
    });

    await emitExecNotifications(path, startMs, {
      exit: 0, heldOps: [], tier: "scoped", costUsd: 0.01, toolCalls: [], task: "render pass",
    }, { env: withToken, fetchFn, repoRoot });

    // git-status changed BOTH files, but only fresh.png clears mtime>=startMs -- assert via the
    // upload calls actually made: exactly one files.getUploadURLExternal, for fresh.png only.
    const uploadCalls = fetchFn.mock.calls.filter((c: any[]) => String(c[0]).includes("getUploadURLExternal"));
    expect(uploadCalls).toHaveLength(1);
    expect(String(uploadCalls[0][0])).toContain("fresh.png");
    expect(String(uploadCalls[0][0])).not.toContain("pre-existing.png");

    // threaded under the dispatch post's ts
    const completeCall = fetchFn.mock.calls.find((c: any[]) => String(c[0]).includes("completeUploadExternal")) as any[] | undefined;
    expect(completeCall).toBeDefined();
    expect(String(completeCall![1].body)).toContain("222.2");
  });

  it("a failed exec posts a failure to ops", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "111.1", channel: "C_WORKSITE" }));
    await emitExecNotifications(path, Date.now(), {
      exit: 1, heldOps: [], tier: "scoped", costUsd: 0.01, toolCalls: [], task: "t",
    }, { env: withToken, fetchFn });
    const bodies = fetchFn.mock.calls.map((c: any[]) => JSON.parse(c[1].body));
    const failure = bodies.find((b: any) => b.channel === "C_OPS");
    expect(failure).toBeDefined();
    expect(failure.text).toContain("failure");
  });

  it("never throws, even against a nonexistent manifest path", async () => {
    const fetchFn = vi.fn();
    await expect(
      emitExecNotifications("/nonexistent/harness.json", Date.now(), {
        exit: 0, heldOps: [], tier: "scoped", costUsd: 0, toolCalls: [], task: "t",
      }, { env: withToken, fetchFn }),
    ).resolves.toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("emitRouteNotifications", () => {
  it("accepted -> dispatch to worksite", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C_WORKSITE" }));
    await emitRouteNotifications(path, { accepted: true, tier: "bulk", costUsd: 0.002, workType: "classify" }, { env: withToken, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_WORKSITE");
  });

  it("rejected -> failure to ops", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C_OPS" }));
    await emitRouteNotifications(path, { accepted: false, tier: "bulk", workType: "classify" }, { env: withToken, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_OPS");
  });

  it("no notify block -> zero calls", async () => {
    const { path } = tmpManifest();
    const fetchFn = vi.fn();
    await emitRouteNotifications(path, { accepted: true, tier: "bulk" }, { env: withToken, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("emitDriftNotifications", () => {
  it("posts drift to ops", async () => {
    const { path } = tmpManifest({ slack: { worksite: "C_WORKSITE", ops: "C_OPS" } });
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C_OPS" }));
    await emitDriftNotifications(path, { suite: "kernel-checks", baselineRate: 1.0, recentRate: 0.5 }, { env: withToken, fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_OPS");
    expect(body.text).toContain("kernel-checks");
  });

  it("no notify block -> zero calls", async () => {
    const { path } = tmpManifest();
    const fetchFn = vi.fn();
    await emitDriftNotifications(path, { suite: "kernel-checks" }, { env: withToken, fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("never throws against an invalid manifest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "harness-notify-emit-bad-"));
    const path = join(dir, "harness.json");
    writeFileSync(path, "{not json");
    await expect(emitDriftNotifications(path, { suite: "x" }, { env: withToken })).resolves.toBeUndefined();
  });
});
