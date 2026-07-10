import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLedger, readLedger, type RunLedgerEntry } from "./harness-run-ledger";
import { attachSocketHandlers, type ListenerContext, type AuditLine } from "./harness-slack-listen";

/**
 * Order J safety tests -- no network, no real exec. A fake socket captures
 * sent frames (for the ACK assertion) and lets tests feed crafted envelopes
 * through the exact `addEventListener("message", ...)` path the real listener
 * uses. dispatchFn/auditFn/readLedgerFn are all plain spies/fakes.
 */
class FakeSocket {
  listeners: Record<string, Array<(ev: any) => void>> = {};
  sent: string[] = [];
  addEventListener(type: string, cb: (ev: any) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    // no-op for tests
  }
  emit(type: string, ev: any): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

const OPERATOR = "U_OPERATOR";
const OTHER_USER = "U_SOMEONE_ELSE";
const BOT_USER = "U_BOT";

function freshAnchor(): string {
  return mkdtempSync(join(tmpdir(), "harness-slack-listen-"));
}

function ledgerEntry(over: Partial<RunLedgerEntry> = {}): RunLedgerEntry {
  return {
    ts: "100.001",
    channel: "C_OPS",
    kind: "gate-held",
    dir: "/tmp/venture",
    task: "deploy the thing",
    heldOps: ["deploy"],
    venture: "agency",
    ...over,
  };
}

function buildCtx(overrides: Partial<ListenerContext> = {}): { ctx: ListenerContext; socket: FakeSocket; dispatchFn: any; auditFn: any; log: any } {
  const socket = new FakeSocket();
  const dispatchFn = vi.fn();
  const auditFn = vi.fn().mockReturnValue(true);
  const log = vi.fn();
  const ctx: ListenerContext = {
    anchor: freshAnchor(),
    operatorId: OPERATOR,
    botUserId: BOT_USER,
    socket: socket as any,
    dispatchFn,
    auditFn,
    readLedgerFn: vi.fn().mockReturnValue(null),
    log,
    ...overrides,
  };
  return { ctx, socket, dispatchFn, auditFn, log };
}

function eventsApiEnvelope(envelopeId: string, event: any) {
  return { envelope_id: envelopeId, type: "events_api", payload: { event } };
}

function reactionAdded(over: Partial<any> = {}) {
  return {
    type: "reaction_added",
    user: OPERATOR,
    reaction: "white_check_mark",
    item: { type: "message", channel: "C_OPS", ts: "100.001" },
    event_ts: "100.002",
    ...over,
  };
}

describe("Order J safety invariants", () => {
  it("1. non-operator reaction on a ledgered gate-held -> dispatchFn NOT called; logged", () => {
    const entry = ledgerEntry();
    const { ctx, dispatchFn, log } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-1", reactionAdded({ user: OTHER_USER }))) });
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("non-operator"));
  });

  it("2. a bot_id event is ignored (no action, no loop)", () => {
    const entry = ledgerEntry();
    const { ctx, dispatchFn, auditFn, log } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", {
      data: JSON.stringify(eventsApiEnvelope("env-2", reactionAdded({ user: OPERATOR, bot_id: "B123" }))),
    });
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(auditFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bot/self"));
  });

  it("2b. an event from the bot's own user id is ignored", () => {
    const entry = ledgerEntry();
    const { ctx, dispatchFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", {
      data: JSON.stringify(eventsApiEnvelope("env-2b", reactionAdded({ user: BOT_USER }))),
    });
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("3. reaction on a ts with no ledger entry -> no action", () => {
    const readLedgerFn = vi.fn().mockReturnValue(null);
    const { ctx, dispatchFn, auditFn, log } = buildCtx({ readLedgerFn });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-3", reactionAdded({ user: OPERATOR }))) });
    expect(readLedgerFn).toHaveBeenCalledWith(ctx.anchor, "100.001");
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(auditFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("unledgered"));
  });

  it("4. operator white_check_mark on a ledgered gate-held -> dispatchFn called with dir, task, --clear <op>", () => {
    const entry = ledgerEntry({ dir: "/tmp/my-venture", task: "deploy prod", heldOps: ["deploy"] });
    const { ctx, dispatchFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-4", reactionAdded({ user: OPERATOR }))) });
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    expect(dispatchFn).toHaveBeenCalledWith({ dir: "/tmp/my-venture", task: "deploy prod", clear: ["deploy"] });
  });

  it("5. every acted event -> exactly one audit line with reactor, message_ts, op, decision", () => {
    const entry = ledgerEntry({ heldOps: ["deploy"] });
    const { ctx, auditFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-5", reactionAdded({ user: OPERATOR }))) });
    expect(auditFn).toHaveBeenCalledTimes(1);
    const line: AuditLine = auditFn.mock.calls[0][0];
    expect(line.reactor).toBe(OPERATOR);
    expect(line.message_ts).toBe("100.001");
    expect(line.op).toBe("deploy");
    expect(line.decision).toBe("approved");
    expect(line.kind).toBe("slack-approval");
  });

  it("6. audit-write failure on an approval -> the dispatch is REFUSED (fail-closed)", () => {
    const entry = ledgerEntry();
    const auditFn = vi.fn().mockReturnValue(false);
    const { ctx, dispatchFn, log } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry), auditFn });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-6", reactionAdded({ user: OPERATOR }))) });
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("REFUSED"));
  });

  it("6b. audit sink throwing is treated the same as returning false -- fail-closed", () => {
    const entry = ledgerEntry();
    const auditFn = vi.fn().mockImplementation(() => {
      throw new Error("disk full");
    });
    const { ctx, dispatchFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry), auditFn });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-6b", reactionAdded({ user: OPERATOR }))) });
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("7. every received envelope -> an ACK {envelope_id} sent", () => {
    const entry = ledgerEntry();
    const { ctx, socket } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    socket.emit("message", { data: JSON.stringify(eventsApiEnvelope("env-7-ack", reactionAdded({ user: OTHER_USER }))) });
    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toEqual({ envelope_id: "env-7-ack" });
  });

  it("7b. a hello envelope is not ACKed (no envelope_id to ack) and never errors", () => {
    const { ctx, socket } = buildCtx();
    attachSocketHandlers(ctx);
    expect(() => socket.emit("message", { data: JSON.stringify({ type: "hello" }) })).not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });

  it("8. operator thread-reply on a ledgered dispatch -> dispatchFn called with the correction text appended", () => {
    const entry = ledgerEntry({ kind: "dispatch", dir: "/tmp/my-venture", task: "run the thing", heldOps: [], ts: "200.001" });
    const { ctx, dispatchFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    const replyEvent = {
      type: "message",
      user: OPERATOR,
      text: "actually use the staging bucket",
      channel: "C_WORKSITE",
      ts: "200.050",
      thread_ts: "200.001",
    };
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-8", replyEvent)) });
    expect(dispatchFn).toHaveBeenCalledTimes(1);
    expect(dispatchFn).toHaveBeenCalledWith({
      dir: "/tmp/my-venture",
      task: "run the thing -- correction: actually use the staging bucket",
    });
  });
});

describe("additional coverage", () => {
  it("decline (x) audits but never dispatches", () => {
    const entry = ledgerEntry({ heldOps: ["deploy"] });
    const { ctx, dispatchFn, auditFn } = buildCtx({ readLedgerFn: vi.fn().mockReturnValue(entry) });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", { data: JSON.stringify(eventsApiEnvelope("env-x", reactionAdded({ user: OPERATOR, reaction: "x" }))) });
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(auditFn).toHaveBeenCalledTimes(1);
    expect(auditFn.mock.calls[0][0].decision).toBe("declined");
  });

  it("a reply that is not threaded (no thread_ts) never dispatches", () => {
    const { ctx, dispatchFn } = buildCtx();
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", {
      data: JSON.stringify(eventsApiEnvelope("env-top", { type: "message", user: OPERATOR, text: "hi", channel: "C1", ts: "300.001" })),
    });
    expect(dispatchFn).not.toHaveBeenCalled();
  });

  it("real run-ledger round trip: appendLedger then readLedger resolves the same entry, wired end-to-end", () => {
    const anchor = freshAnchor();
    const entry = ledgerEntry({ ts: "999.001", dir: anchor, heldOps: ["deploy"] });
    appendLedger(anchor, entry);
    expect(readLedger(anchor, "999.001")).toEqual(entry);
    expect(readLedger(anchor, "no-such-ts")).toBeNull();

    const { ctx, dispatchFn } = buildCtx({ anchor, readLedgerFn: readLedger });
    attachSocketHandlers(ctx);
    (ctx.socket as any).emit("message", {
      data: JSON.stringify(eventsApiEnvelope("env-e2e", reactionAdded({ user: OPERATOR, item: { type: "message", channel: "C_OPS", ts: "999.001" } }))),
    });
    expect(dispatchFn).toHaveBeenCalledWith({ dir: anchor, task: entry.task, clear: ["deploy"] });
  });

  it("a malformed message frame never throws and never dispatches", () => {
    const { ctx, dispatchFn, log } = buildCtx();
    attachSocketHandlers(ctx);
    expect(() => (ctx.socket as any).emit("message", { data: "not json{{{" })).not.toThrow();
    expect(dispatchFn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("bad envelope"));
  });
});
