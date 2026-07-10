import { describe, it, expect, vi } from "vitest";
import {
  routeEvent,
  notify,
  formatDispatch,
  formatArtefact,
  formatGateHeld,
  formatDrift,
  formatFailure,
  formatDigest,
  formatCommit,
  summarizeTask,
  type NotifyConfig,
} from "./harness-notify";

const cfg: NotifyConfig = { worksite: "C_WORKSITE", ops: "C_OPS" };
const withToken: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: "xoxb-test" };
const noToken: NodeJS.ProcessEnv = {};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("routeEvent", () => {
  it("dispatch and artefact route to worksite", () => {
    expect(routeEvent("dispatch", cfg)).toBe("C_WORKSITE");
    expect(routeEvent("artefact", cfg)).toBe("C_WORKSITE");
  });

  it("gate-held, drift, and failure route to ops", () => {
    expect(routeEvent("gate-held", cfg)).toBe("C_OPS");
    expect(routeEvent("drift", cfg)).toBe("C_OPS");
    expect(routeEvent("failure", cfg)).toBe("C_OPS");
  });

  it("digest routes to ops (studio roll-up)", () => {
    expect(routeEvent("digest", cfg)).toBe("C_OPS");
  });

  it("commit routes to worksite (it's work, not an alert)", () => {
    expect(routeEvent("commit", cfg)).toBe("C_WORKSITE");
  });

  it("a trimmed event returns null", () => {
    const trimmed: NotifyConfig = { ...cfg, events: ["dispatch"] };
    expect(routeEvent("failure", trimmed)).toBeNull();
    expect(routeEvent("dispatch", trimmed)).toBe("C_WORKSITE");
  });

  it("an unset target channel returns null", () => {
    expect(routeEvent("dispatch", { ops: "C_OPS" })).toBeNull();
    expect(routeEvent("failure", { worksite: "C_WORKSITE" })).toBeNull();
  });
});

describe("NotifyConfig.telemetry (Order P)", () => {
  it("is accepted alongside worksite/ops and carried on the config -- no NotifyKind routes to it, artefacts upload straight via `harness post --channel telemetry` instead of notify()", () => {
    const withTelemetry: NotifyConfig = { worksite: "C_WORKSITE", ops: "C_OPS", telemetry: "C_TELEMETRY" };
    expect(withTelemetry.telemetry).toBe("C_TELEMETRY");
    expect(routeEvent("dispatch", withTelemetry)).toBe("C_WORKSITE");
    expect(routeEvent("failure", withTelemetry)).toBe("C_OPS");
  });
});

describe("summarizeTask", () => {
  it("keeps a short single-line task whole", () => {
    expect(summarizeTask("run the thing")).toBe("run the thing");
  });

  it("takes the first non-empty line", () => {
    expect(summarizeTask("\n  \nfirst real line\nsecond line")).toBe("first real line");
  });

  it("truncates past max and appends an ellipsis", () => {
    const long = "x".repeat(200);
    const s = summarizeTask(long, 150);
    expect(s.length).toBe(151);
    expect(s.endsWith("…")).toBe(true);
    expect(s.startsWith("x".repeat(150))).toBe(true);
  });
});

describe("formatters -- deterministic, render key fields + non-empty blocks", () => {
  it("formatDispatch", () => {
    const { text, blocks } = formatDispatch({
      venture: "agency",
      task: "run the thing",
      tier: "scoped",
      costUsd: 0.0123,
      verdict: "accepted",
      tools: ["Read", "Edit"],
      ctxTokens: 4000,
      memTokens: 200,
    });
    expect(text).toContain("agency");
    expect(text).toContain("run the thing");
    expect(text).toContain("scoped");
    expect(text).toContain("accepted");
    expect(text).toContain("$0.0123");
    expect(text).toContain("4000tok");
    expect(text).toContain("Read, Edit");

    expect(blocks.length).toBeGreaterThan(0);
    const header: any = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text.text).toContain(":white_check_mark:");
    expect(header.text.text).toContain("agency");
    const section: any = blocks[1];
    expect(section.text.text).toContain("run the thing");
    const context: any = blocks[2];
    expect(context.elements[0].text).toContain("scoped");
  });

  it("formatDispatch summarizes a long task in both text and the section block", () => {
    const long = "line one is very long ".repeat(20);
    const { text, blocks } = formatDispatch({ venture: "agency", task: long, tier: "scoped" });
    const summary = long.trim().slice(0, 150) + "…";
    expect(text).toContain(summary);
    const section: any = blocks[1];
    expect(section.text.text).toBe(summary);
  });

  it("formatArtefact", () => {
    const { text, blocks } = formatArtefact({ venture: "apsis", path: "out/render.png", caption: "hero pass" });
    expect(text).toContain("apsis");
    expect(text).toContain("out/render.png");
    expect(text).toContain("hero pass");
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("formatGateHeld", () => {
    const { text, blocks } = formatGateHeld({ venture: "agency", op: "db-write", commandPreview: "INSERT INTO leads" });
    expect(text).toContain("agency");
    expect(text).toContain("db-write");
    expect(text).toContain("INSERT INTO leads");

    const header: any = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text.text).toContain(":double_vertical_bar:");
    expect(header.text.text).toContain("db-write");
    const codeSection: any = blocks[1];
    expect(codeSection.text.text).toContain("INSERT INTO leads");
    const context: any = blocks[blocks.length - 1];
    expect(context.elements[0].text).toContain(":white_check_mark:");
    expect(context.elements[0].text).toContain(":x:");
  });

  it("formatDrift", () => {
    const { text, blocks } = formatDrift({
      venture: "ortova",
      suite: "kernel-checks",
      baselineRate: 1.0,
      recentRate: 0.4,
      revokedGates: ["promote"],
      recompileVerdict: "clean",
    });
    expect(text).toContain("ortova");
    expect(text).toContain("kernel-checks");
    expect(text).toContain("1.00");
    expect(text).toContain("0.40");
    expect(text).toContain("promote");
    expect(text).toContain("clean");

    const header: any = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text.text).toContain(":warning:");
    expect(header.text.text).toContain("kernel-checks");
  });

  it("formatFailure", () => {
    const { text, blocks } = formatFailure({ venture: "agency", what: "processTrigger", why: "Meta API 500" });
    expect(text).toContain("agency");
    expect(text).toContain("processTrigger");
    expect(text).toContain("Meta API 500");

    const header: any = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text.text).toContain(":x:");
    const section: any = blocks[1];
    expect(section.text.text).toContain("processTrigger");
    const context: any = blocks[2];
    expect(context.elements[0].text).toContain("Meta API 500");
  });

  it("formatDigest", () => {
    const { text, blocks } = formatDigest({
      venture: "studio",
      costPerAccepted: 0.42,
      accepted: 10,
      failed: 2,
      revocations: ["tier_swap"],
    });
    expect(text).toContain("studio");
    expect(text).toContain("accepted 10");
    expect(text).toContain("failed 2");
    expect(text).toContain("$0.4200");
    expect(text).toContain("tier_swap");
    expect(blocks.length).toBeGreaterThan(0);
  });

  it("formatCommit", () => {
    const { text, blocks } = formatCommit({
      venture: "agency",
      sha: "abc1234def5678900000000000000000000000",
      subject: "feat(agency): add lead scorer",
      filesChanged: 3,
      insertions: 42,
      deletions: 7,
      branch: "main",
    });
    expect(text).toContain("agency");
    expect(text).toContain("abc1234");
    expect(text).not.toContain("abc1234def5678900000000000000000000000");
    expect(text).toContain("feat(agency): add lead scorer");
    expect(text).toContain("3 files");
    expect(text).toContain("+42/-7");
    expect(text).toContain("main");

    const header: any = blocks[0];
    expect(header.type).toBe("header");
    expect(header.text.text).toContain(":pencil:");
    expect(header.text.text).toContain("agency");
    expect(header.text.text).toContain("abc1234");
    expect(header.text.text).not.toContain("abc1234def5678900000000000000000000000");

    const section: any = blocks[1];
    expect(section.text.text).toBe("feat(agency): add lead scorer");

    const context: any = blocks[2];
    expect(context.elements[0].text).toContain("3 files");
    expect(context.elements[0].text).toContain("+42/-7");
    expect(context.elements[0].text).toContain("main");
  });

  it("formatCommit takes only the first line of a multi-line commit message", () => {
    const { text, blocks } = formatCommit({
      venture: "agency",
      sha: "1234567abcdef",
      subject: "feat: short subject\n\nA much longer body explaining why, with detail that\nshould never leak into the Slack card.",
    });
    expect(text).toContain("feat: short subject");
    expect(text).not.toContain("should never leak");
    const section: any = blocks[1];
    expect(section.text.text).toBe("feat: short subject");
  });

  it("formatCommit omits stat parts that are absent", () => {
    const { text, blocks } = formatCommit({ venture: "agency", sha: "1234567abcdef", subject: "chore: bump" });
    expect(text).not.toContain("--");
    expect(blocks.length).toBe(2);
  });
});

describe("notify", () => {
  it("routes, formats, and posts -- hits chat.postMessage on the resolved channel", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1.1", channel: "C_WORKSITE" }));
    const res = await notify(
      { kind: "dispatch", venture: "agency", task: "t", tier: "scoped" },
      cfg,
      { env: withToken, fetchFn },
    );
    expect(res.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_WORKSITE");
    expect(body.text).toContain("agency");
    expect(Array.isArray(body.blocks)).toBe(true);
    expect(body.blocks.length).toBeGreaterThan(0);
  });

  it("commit routes, formats, and posts to worksite", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "2.2", channel: "C_WORKSITE" }));
    const res = await notify(
      { kind: "commit", venture: "agency", sha: "1234567abcdef", subject: "feat: thing" },
      cfg,
      { env: withToken, fetchFn },
    );
    expect(res.ok).toBe(true);
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.channel).toBe("C_WORKSITE");
    expect(body.text).toContain("1234567");
  });

  it("unrouted/trimmed/unset kind -> skip, no fetch call", async () => {
    const fetchFn = vi.fn();
    const trimmed: NotifyConfig = { ...cfg, events: ["dispatch"] };
    const res = await notify({ kind: "failure", venture: "agency", what: "x", why: "y" }, trimmed, {
      env: withToken,
      fetchFn,
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBeDefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("tokenless -> skip via the transport's honest-skip, never throws", async () => {
    const fetchFn = vi.fn();
    const res = await notify({ kind: "dispatch", venture: "agency", task: "t", tier: "scoped" }, cfg, {
      env: noToken,
      fetchFn,
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toMatch(/SLACK_BOT_TOKEN/);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
