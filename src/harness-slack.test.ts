import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slackPostMessage,
  slackUploadFile,
  resolveChannelId,
  postedKey,
  alreadyPosted,
  recordPosted,
} from "./harness-slack";

const freshDir = (): string => mkdtempSync(join(tmpdir(), "slack-"));
const noToken: NodeJS.ProcessEnv = {};
const withToken: NodeJS.ProcessEnv = { SLACK_BOT_TOKEN: "xoxb-test-token" };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe("slackPostMessage", () => {
  it("tokenless -> skipped, no fetch call", async () => {
    const fetchFn = vi.fn();
    const res = await slackPostMessage({ channel: "C1", text: "hi", env: noToken, fetchFn });
    expect(res.skipped).toMatch(/SLACK_BOT_TOKEN/);
    expect(res.ok).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("success -> hits chat.postMessage with channel + text", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "123.456", channel: "C1" }));
    const res = await slackPostMessage({ channel: "C1", text: "hello world", env: withToken, fetchFn });
    expect(res.ok).toBe(true);
    expect(res.ts).toBe("123.456");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toContain("chat.postMessage");
    const body = JSON.parse(init.body);
    expect(body.channel).toBe("C1");
    expect(body.text).toBe("hello world");
    expect(body.thread_ts).toBeUndefined();
    expect(init.headers.Authorization).toBe("Bearer xoxb-test-token");
  });

  it("threads with thread_ts when given", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C1" }));
    await slackPostMessage({ channel: "C1", text: "reply", threadTs: "999.111", env: withToken, fetchFn });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.thread_ts).toBe("999.111");
  });

  it("never throws on a Slack API error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: false, error: "channel_not_found" }));
    const res = await slackPostMessage({ channel: "Cbad", text: "x", env: withToken, fetchFn });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/channel_not_found/);
  });

  it("never throws when fetch rejects", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down"));
    const res = await slackPostMessage({ channel: "C1", text: "x", env: withToken, fetchFn });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/network down/);
  });

  it("includes blocks in the POST body when given", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C1" }));
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: "hi" } }];
    await slackPostMessage({ channel: "C1", text: "hi", blocks, env: withToken, fetchFn });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.blocks).toEqual(blocks);
    expect(body.text).toBe("hi");
  });

  it("omits blocks from the POST body when not given", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, ts: "1", channel: "C1" }));
    await slackPostMessage({ channel: "C1", text: "hi", env: withToken, fetchFn });
    const body = JSON.parse(fetchFn.mock.calls[0][1].body);
    expect(body.blocks).toBeUndefined();
  });
});

describe("slackUploadFile", () => {
  it("tokenless -> skipped, no fetch call", async () => {
    const dir = freshDir();
    const path = join(dir, "a.png");
    writeFileSync(path, "bytes");
    const fetchFn = vi.fn();
    const res = await slackUploadFile({ channel: "C1", path, env: noToken, fetchFn });
    expect(res.skipped).toMatch(/SLACK_BOT_TOKEN/);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("the three calls fire in order with the right filename/length and threaded file_id", async () => {
    const dir = freshDir();
    const path = join(dir, "render.png");
    writeFileSync(path, "0123456789"); // length 10

    const calls: string[] = [];
    const fetchFn = vi.fn(async (url: string, init?: any) => {
      calls.push(url);
      if (url.includes("getUploadURLExternal")) {
        expect(url).toContain("filename=render.png");
        expect(url).toContain("length=10");
        return jsonResponse({ ok: true, upload_url: "https://upload.example/put", file_id: "F123" });
      }
      if (url.includes("upload.example")) {
        return jsonResponse({});
      }
      if (url.includes("completeUploadExternal")) {
        return jsonResponse({ ok: true, files: [{ id: "F123" }] });
      }
      throw new Error(`unexpected url ${url}`);
    });

    const res = await slackUploadFile({
      channel: "C1",
      path,
      title: "render.png",
      comment: "a caption",
      dedup: false,
      env: withToken,
      fetchFn: fetchFn as any,
    });

    expect(res.ok).toBe(true);
    expect(res.fileId).toBe("F123");
    expect(calls[0]).toContain("getUploadURLExternal");
    expect(calls[1]).toBe("https://upload.example/put");
    expect(calls[2]).toContain("completeUploadExternal");

    const completeInit = fetchFn.mock.calls[2][1];
    const completeBody = new URLSearchParams(completeInit.body);
    expect(completeBody.get("channel_id")).toBe("C1");
    expect(completeBody.get("initial_comment")).toBe("a caption");
    const files = JSON.parse(completeBody.get("files") as string);
    expect(files[0].id).toBe("F123");
  });

  it("dedup: second upload of the same key is skipped without hitting fetch", async () => {
    const dir = freshDir();
    const path = join(dir, "dup.png");
    writeFileSync(path, "dupbytes");
    const ledgerPath = join(dir, "ledger.txt");
    const fetchFn = vi.fn(async (url: string) => {
      if (url.includes("getUploadURLExternal")) {
        return jsonResponse({ ok: true, upload_url: "https://upload.example/put", file_id: "F1" });
      }
      if (url.includes("upload.example")) return jsonResponse({});
      if (url.includes("completeUploadExternal")) return jsonResponse({ ok: true });
      throw new Error("unexpected");
    });

    const first = await slackUploadFile({ channel: "C1", path, ledgerPath, env: withToken, fetchFn: fetchFn as any });
    expect(first.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);

    fetchFn.mockClear();
    const second = await slackUploadFile({ channel: "C1", path, ledgerPath, env: withToken, fetchFn: fetchFn as any });
    expect(second.ok).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("resolveChannelId", () => {
  it("a C-id passes through as-is", async () => {
    const res = await resolveChannelId("C0123456", { env: withToken });
    expect(res).toBe("C0123456");
  });

  it("resolves a #name via conversations.list", async () => {
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse({ ok: true, channels: [{ id: "C999", name: "worksite" }] }),
    );
    const res = await resolveChannelId("#worksite", { env: withToken, fetchFn });
    expect(res).toBe("C999");
  });

  it("unknown name -> null", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ ok: true, channels: [] }));
    const res = await resolveChannelId("nope", { env: withToken, fetchFn });
    expect(res).toBeNull();
  });

  it("tokenless name lookup -> null (never throws)", async () => {
    const res = await resolveChannelId("#worksite", { env: noToken });
    expect(res).toBeNull();
  });
});

describe("postedKey / alreadyPosted / recordPosted", () => {
  it("round-trips through the ledger", () => {
    const dir = freshDir();
    const path = join(dir, "x.png");
    writeFileSync(path, "content");
    const ledgerPath = join(dir, "sub", "ledger.txt");
    const key = postedKey("C1", path);
    expect(alreadyPosted(key, ledgerPath)).toBe(false);
    recordPosted(key, ledgerPath);
    expect(alreadyPosted(key, ledgerPath)).toBe(true);
  });

  it("missing ledger -> false, never throws", () => {
    expect(alreadyPosted("some|key|1", "/tmp/does-not-exist-lingot-ledger.txt")).toBe(false);
  });
});
