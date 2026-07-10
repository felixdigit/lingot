import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Black-box test of the `harness post` verb's channel-keyword resolution
 * (Order P). harness-cli.ts is a top-level script (process.exit on every
 * branch), not an importable module, so this drives the real binary the same
 * way `pnpm harness post ...` does -- matching the "tool gate script" test
 * style in harness.test.ts (execFileSync against the real file).
 *
 * No SLACK_BOT_TOKEN in the spawned env: a resolved channel always ends in an
 * honest skip (exit 0, `skipped: "no SLACK_BOT_TOKEN..."`), never a network
 * call. An UNRESOLVED channel keyword fails earlier, before the token check,
 * with a distinct exit 1 + stderr message -- that's what distinguishes
 * "telemetry resolved" from "telemetry rejected" here.
 */
const cliPath = fileURLToPath(new URL("./harness-cli.ts", import.meta.url));

function runPost(dir: string, channel: string): { status: number; stdout: string; stderr: string } {
  // Set (not delete): harness-cli.ts's loadDotEnv() only fills a var that is
  // `undefined`, and the repo-root .env carries a real SLACK_BOT_TOKEN -- an
  // empty string stays "defined" (blocks that fallback) while still reading as
  // absent to resolveToken (length 0), so the CLI takes the honest-skip path.
  const env = { ...process.env, SLACK_BOT_TOKEN: "" };
  try {
    const stdout = execFileSync("npx", ["tsx", cliPath, "post", "dummy.png", "--channel", channel, "--dir", dir], {
      encoding: "utf8",
      env,
      timeout: 30_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e: any) {
    return { status: e.status ?? 1, stdout: e.stdout?.toString() ?? "", stderr: e.stderr?.toString() ?? "" };
  }
}

describe("harness post --channel telemetry (Order P)", () => {
  const base = { harness: "harness/v1", identity: { name: "t", kind: "venture", owners: ["felix"] }, kernel: { version: "~> 1" } };

  it("resolves the telemetry keyword to notify.slack.telemetry -- reaches the token check, not a channel error", () => {
    const dir = mkdtempSync(join(tmpdir(), "post-telemetry-"));
    writeFileSync(join(dir, "harness.json"), JSON.stringify({ ...base, notify: { slack: { telemetry: "C_TELEMETRY" } } }));
    const r = runPost(dir, "telemetry");
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, skipped: "no SLACK_BOT_TOKEN -- transport inactive" });
  }, 30_000);

  it("errors when the venture has no notify.slack.telemetry configured (distinct from worksite/ops)", () => {
    const dir = mkdtempSync(join(tmpdir(), "post-telemetry-"));
    writeFileSync(join(dir, "harness.json"), JSON.stringify({ ...base, notify: { slack: { worksite: "C_W" } } }));
    const r = runPost(dir, "telemetry");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no notify.slack.telemetry channel configured");
  }, 30_000);
});
