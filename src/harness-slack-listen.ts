import { execFile } from "node:child_process";
import { readLedger, type RunLedgerEntry } from "./harness-run-ledger";
import { type SlackFetch } from "./harness-slack";
import { defaultAuditSink } from "./harness-slack-audit";

/**
 * The Socket Mode two-way listener (Order J, docs/harness/slack-notify-map.md
 * Section 7 -- the LOCKED safety model). A local, long-running process that
 * turns a Slack reaction/reply on a ledgered post (Order J's run-ledger,
 * written by the Order I emit layer) into a harness action. Native `WebSocket`
 * only, no new dependency. Every moving part -- the socket source, the
 * dispatch executor, the audit sink -- is injectable so this whole module is
 * unit-testable with no network and no real exec.
 *
 * SAFETY MODEL (this is the point of the module, not an afterthought):
 *   1. Single actor -- only `event.user === operatorId` may cause ANY action.
 *   2. No loops -- bot_id / bot's own user id events are ignored outright.
 *   3. Ledger-bound -- a reaction/reply on an unledgered ts does nothing.
 *   4. Bounded authority -- the only action is a re-dispatch of the gated
 *      `harness exec` executor, clearing EXACTLY the approved op(s).
 *   5. Audit every act -- approval/decline/correction each append one JSON
 *      line to the venture's .harness/audit.jsonl.
 *   6. Fail-closed -- an approval/correction whose audit write fails is
 *      REFUSED (never dispatched).
 * (Point 7, no operator id -> refuse to start, lives in `runListener` below.)
 */

// ---------------------------------------------------------------------------
// Injectable seams
// ---------------------------------------------------------------------------

/** Minimal surface of a Socket Mode connection -- matches native WebSocket's event API. */
export interface ListenerSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", cb: (ev: any) => void): void;
}

export type ConnectFn = () => Promise<ListenerSocket>;

export interface DispatchArgs {
  readonly dir: string;
  readonly task: string;
  /** Ops to clear via `--clear op1,op2` -- exactly the approved op(s), never others. */
  readonly clear?: readonly string[];
}

export type DispatchFn = (args: DispatchArgs) => void;

export interface AuditLine {
  readonly at: string;
  readonly kind: "slack-approval" | "slack-decline" | "slack-correction" | "slack-signal";
  readonly run: string;
  readonly op: string;
  readonly reactor: string;
  readonly message_ts: string;
  readonly decision: string;
}

/** Returns true iff the audit write succeeded. A failed write REFUSES the acting event (fail-closed). */
export type AuditFn = (line: AuditLine) => boolean;

export type ReadLedgerFn = (anchor: string, ts: string) => RunLedgerEntry | null;

export type ReactionAddFn = (channel: string, ts: string, name: string) => void;

export interface ListenerContext {
  readonly anchor: string;
  readonly operatorId: string;
  readonly botUserId?: string;
  readonly socket: ListenerSocket;
  readonly dispatchFn: DispatchFn;
  readonly auditFn: AuditFn;
  readonly readLedgerFn: ReadLedgerFn;
  readonly reactionAddFn?: ReactionAddFn;
  readonly log: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// Defaults for the injectable seams (real socket, real exec, real audit file)
// ---------------------------------------------------------------------------

/** Real connect: apps.connections.open -> a native WebSocket to the returned wss URL. */
export async function realConnect(env: NodeJS.ProcessEnv, fetchFn?: SlackFetch): Promise<ListenerSocket> {
  const appToken = env.SLACK_APP_TOKEN;
  if (!appToken) throw new Error("harness slack listen: SLACK_APP_TOKEN not set");
  const doFetch = fetchFn ?? ((fetch as unknown) as SlackFetch);
  const r = await doFetch("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: { Authorization: `Bearer ${appToken}` },
  });
  if (!r.ok) throw new Error(`apps.connections.open HTTP ${r.status}`);
  const j = await r.json();
  if (!j?.ok || typeof j.url !== "string") {
    throw new Error(`apps.connections.open: ${j?.error ?? "no url returned"}`);
  }
  return new WebSocket(j.url) as unknown as ListenerSocket;
}

/** Real dispatch: re-invoke `pnpm harness exec <dir> "<task>" [--clear op,op]` -- the SAME gated executor. */
export function defaultDispatchFn(env: NodeJS.ProcessEnv = process.env): DispatchFn {
  return ({ dir, task, clear }) => {
    const cliArgs = ["harness", "exec", dir, task];
    if (clear && clear.length) cliArgs.push("--clear", clear.join(","));
    execFile("pnpm", cliArgs, { env, cwd: dir }, (err) => {
      if (err) console.error(`harness slack listen: dispatch failed -- ${err.message}`);
    });
  };
}

/** Real reaction ack: reactions.add, best-effort (never throws out of the caller). */
export function defaultReactionAddFn(env: NodeJS.ProcessEnv, fetchFn?: SlackFetch): ReactionAddFn {
  const doFetch = fetchFn ?? ((fetch as unknown) as SlackFetch);
  return (channel, ts, name) => {
    const token = env.SLACK_BOT_TOKEN;
    if (!token) return;
    doFetch("https://slack.com/api/reactions.add", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ channel, timestamp: ts, name }),
    }).catch(() => {
      // best-effort ack reaction -- never blocks the acting event.
    });
  };
}

// ---------------------------------------------------------------------------
// Core event handling -- pure w.r.t. its injected context, fully unit-testable
// ---------------------------------------------------------------------------

function safeAudit(ctx: ListenerContext, line: AuditLine): boolean {
  try {
    return !!ctx.auditFn(line);
  } catch {
    return false;
  }
}

function ack(ctx: ListenerContext, envelopeId?: string): void {
  if (!envelopeId) return;
  try {
    ctx.socket.send(JSON.stringify({ envelope_id: envelopeId }));
  } catch (e) {
    ctx.log(`harness slack listen: ack send failed -- ${(e as Error)?.message ?? e}`);
  }
}

/** SAFETY 2 -- no loops: a bot_id event, or one from the bot's own user id, is ignored outright. */
function isBotOrSelf(event: any, ctx: ListenerContext): boolean {
  if (event.bot_id) return true;
  if (ctx.botUserId && event.user === ctx.botUserId) return true;
  return false;
}

/** SAFETY 1 -- single actor: only the operator's own event may cause any action. */
function isOperator(event: any, ctx: ListenerContext): boolean {
  return typeof event.user === "string" && event.user === ctx.operatorId;
}

function opsOf(entry: RunLedgerEntry): string {
  return (entry.heldOps ?? []).join(",");
}

function approveHeld(entry: RunLedgerEntry, event: any, ctx: ListenerContext): void {
  const line: AuditLine = {
    at: new Date().toISOString(),
    kind: "slack-approval",
    run: entry.dir,
    op: opsOf(entry),
    reactor: event.user,
    message_ts: entry.ts,
    decision: "approved",
  };
  // SAFETY 6 -- fail-closed: an approval whose audit write fails is REFUSED, never dispatched.
  if (!safeAudit(ctx, line)) {
    ctx.log(`harness slack listen: audit write failed -- approval on ${entry.ts} REFUSED (fail-closed)`);
    return;
  }
  // SAFETY 4 -- bounded authority: re-dispatch the SAME gated executor, clearing exactly the held op(s).
  ctx.dispatchFn({ dir: entry.dir, task: entry.task, clear: [...entry.heldOps] });
  if (ctx.reactionAddFn && entry.channel) {
    try {
      ctx.reactionAddFn(entry.channel, entry.ts, "white_check_mark");
    } catch {
      // best-effort bot ack -- never blocks the acted-on approval.
    }
  }
}

function declineHeld(entry: RunLedgerEntry, event: any, ctx: ListenerContext): void {
  const line: AuditLine = {
    at: new Date().toISOString(),
    kind: "slack-decline",
    run: entry.dir,
    op: opsOf(entry),
    reactor: event.user,
    message_ts: entry.ts,
    decision: "declined",
  };
  safeAudit(ctx, line);
  ctx.log(`harness slack listen: decline logged for ${entry.ts} (${opsOf(entry)}) -- no dispatch`);
}

function recordSignal(entry: RunLedgerEntry, event: any, reaction: string, ctx: ListenerContext): void {
  const line: AuditLine = {
    at: new Date().toISOString(),
    kind: "slack-signal",
    run: entry.dir,
    op: opsOf(entry),
    reactor: event.user,
    message_ts: entry.ts,
    decision: reaction,
  };
  safeAudit(ctx, line);
}

function handleReaction(event: any, ctx: ListenerContext): void {
  const item = event.item;
  if (!item || item.type !== "message" || typeof item.ts !== "string") return;
  // SAFETY 3 -- ledger-bound: a reaction on a ts with no run-ledger entry does nothing.
  const entry = ctx.readLedgerFn(ctx.anchor, item.ts);
  if (!entry) {
    ctx.log(`harness slack listen: reaction on unledgered ts ${item.ts} -- no action`);
    return;
  }
  const reaction = event.reaction;
  if (reaction === "white_check_mark") {
    if (entry.kind !== "gate-held") {
      ctx.log(`harness slack listen: white_check_mark on a non-gate-held post (${entry.kind}) -- ignored`);
      return;
    }
    approveHeld(entry, event, ctx);
  } else if (reaction === "x") {
    if (entry.kind !== "gate-held") {
      ctx.log(`harness slack listen: x on a non-gate-held post (${entry.kind}) -- ignored`);
      return;
    }
    declineHeld(entry, event, ctx);
  } else if (reaction === "+1" || reaction === "-1") {
    recordSignal(entry, event, reaction, ctx);
  } else {
    ctx.log(`harness slack listen: unrecognized reaction "${reaction}" -- ignored`);
  }
}

function handleThreadReply(event: any, ctx: ListenerContext): void {
  const ledgerTs = event.thread_ts;
  if (typeof ledgerTs !== "string") return;
  // SAFETY 3 -- ledger-bound.
  const entry = ctx.readLedgerFn(ctx.anchor, ledgerTs);
  if (!entry) {
    ctx.log(`harness slack listen: reply on unledgered thread ${ledgerTs} -- no action`);
    return;
  }
  if (entry.kind !== "dispatch" && entry.kind !== "failure") {
    ctx.log(`harness slack listen: reply on a non-dispatch/failure post (${entry.kind}) -- ignored`);
    return;
  }
  const correctionText = typeof event.text === "string" ? event.text : "";
  const line: AuditLine = {
    at: new Date().toISOString(),
    kind: "slack-correction",
    run: entry.dir,
    op: opsOf(entry),
    reactor: event.user,
    message_ts: entry.ts,
    decision: "correction",
  };
  // SAFETY 6 -- fail-closed for the correction dispatch too (same principle as approval).
  if (!safeAudit(ctx, line)) {
    ctx.log(`harness slack listen: audit write failed -- correction on ${entry.ts} REFUSED (fail-closed)`);
    return;
  }
  ctx.dispatchFn({ dir: entry.dir, task: `${entry.task} -- correction: ${correctionText}` });
}

function handleEvent(event: any, ctx: ListenerContext): void {
  if (!event || typeof event !== "object") return;
  // SAFETY 2 -- no loops.
  if (isBotOrSelf(event, ctx)) {
    ctx.log("harness slack listen: ignoring bot/self event (no-loop floor)");
    return;
  }
  // SAFETY 1 -- single actor.
  if (!isOperator(event, ctx)) {
    ctx.log(`harness slack listen: ignoring event from non-operator user ${event.user ?? "?"}`);
    return;
  }
  if (event.type === "reaction_added") {
    handleReaction(event, ctx);
    return;
  }
  if (event.type === "message" && typeof event.thread_ts === "string") {
    handleThreadReply(event, ctx);
    return;
  }
  // Any other operator event (e.g. a top-level message) is logged and ignored.
}

/** One received envelope: ACK first (Slack drops the socket without one within 3s), then act. Never throws. */
export function handleEnvelope(envelope: any, ctx: ListenerContext): void {
  try {
    if (!envelope || typeof envelope !== "object") return;
    const type = envelope.type;
    if (type === "hello") {
      ctx.log("harness slack listen: ready (hello received)");
      return;
    }
    if (type === "disconnect") {
      ctx.log(`harness slack listen: disconnect requested (${envelope.reason ?? "unknown"})`);
      return;
    }
    // events_api (and any future interactive envelope) -- ACK immediately, per Slack's 3s rule.
    ack(ctx, envelope.envelope_id);
    if (type !== "events_api") return;
    const event = envelope.payload?.event;
    if (!event) return;
    handleEvent(event, ctx);
  } catch (e) {
    // one bad event never kills the listener.
    ctx.log(`harness slack listen: envelope handling error -- ${(e as Error)?.message ?? e}`);
  }
}

/** Wire a socket's message/close/error events into `handleEnvelope`. Never throws out of the handlers. */
export function attachSocketHandlers(ctx: ListenerContext): void {
  ctx.socket.addEventListener("message", (ev: any) => {
    try {
      const raw = typeof ev?.data === "string" ? ev.data : String(ev?.data ?? "");
      const envelope = JSON.parse(raw);
      handleEnvelope(envelope, ctx);
    } catch (e) {
      ctx.log(`harness slack listen: bad envelope -- ${(e as Error)?.message ?? e}`);
    }
  });
  ctx.socket.addEventListener("close", () => ctx.log("harness slack listen: socket closed"));
  ctx.socket.addEventListener("error", () => ctx.log("harness slack listen: socket error"));
}

// ---------------------------------------------------------------------------
// The long-running loop (reconnect, bounded backoff) -- CLI-runtime only, not
// exercised directly by the unit tests (they drive attachSocketHandlers /
// handleEnvelope against a fake socket instead).
// ---------------------------------------------------------------------------

export interface ListenerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly anchor?: string;
  readonly connectFn?: ConnectFn;
  readonly dispatchFn?: DispatchFn;
  readonly auditFn?: AuditFn;
  readonly readLedgerFn?: ReadLedgerFn;
  readonly reactionAddFn?: ReactionAddFn;
  readonly fetchFn?: SlackFetch;
  readonly backoffMs?: readonly number[];
  readonly log?: (msg: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run the listener forever: connect, ACK+handle events, reconnect with bounded
 * backoff on disconnect/close/error. SAFETY 7 -- fail-closed if the operator id
 * is unset (with no operator id, nothing could ever be authorized).
 */
export async function runListener(opts: ListenerOptions = {}): Promise<never> {
  const env = opts.env ?? process.env;
  const operatorId = env.SLACK_OPERATOR_ID;
  if (!operatorId) {
    throw new Error(
      "harness slack listen: SLACK_OPERATOR_ID not set -- refusing to start (fail-closed: with no operator id, nothing could ever be authorized)",
    );
  }
  const anchor = opts.anchor ?? process.cwd();
  const log = opts.log ?? ((msg: string) => console.log(msg));
  const dispatchFn = opts.dispatchFn ?? defaultDispatchFn(env);
  const auditFn = opts.auditFn ?? defaultAuditSink(anchor);
  const readLedgerFn = opts.readLedgerFn ?? readLedger;
  const reactionAddFn = opts.reactionAddFn ?? defaultReactionAddFn(env, opts.fetchFn);
  const connectFn = opts.connectFn ?? (() => realConnect(env, opts.fetchFn));
  const backoff = opts.backoffMs ?? [1000, 2000, 5000, 10000, 30000];

  let attempt = 0;
  for (;;) {
    try {
      const socket = await connectFn();
      attempt = 0;
      await new Promise<void>((resolve) => {
        const ctx: ListenerContext = {
          anchor,
          operatorId,
          botUserId: env.SLACK_BOT_USER_ID,
          socket,
          dispatchFn,
          auditFn,
          readLedgerFn,
          reactionAddFn,
          log,
        };
        attachSocketHandlers(ctx);
        socket.addEventListener("close", () => resolve());
        socket.addEventListener("error", () => resolve());
      });
    } catch (e) {
      log(`harness slack listen: connect error -- ${(e as Error)?.message ?? e}`);
    }
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    attempt++;
    log(`harness slack listen: reconnecting in ${wait}ms`);
    await sleep(wait);
  }
}
