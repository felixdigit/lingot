import { existsSync, mkdirSync, readFileSync, appendFileSync, statSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";

/**
 * The Slack transport (docs/harness/slack-notify-map.md Section 9, Order H). Ports
 * the PROVEN apps/apsis/engine/core/slack.py + apps/apsis/samples/slack_send.sh
 * transport to TypeScript as the harness's L6 notify sink. Pure, injectable,
 * never-throws: a Slack hiccup never breaks a run. Reads SLACK_BOT_TOKEN from env
 * (default process.env) and NEVER logs or returns the token value. Node built-ins
 * + global fetch/FormData/Blob only -- no new dependency.
 */

const SLACK_API = "https://slack.com/api";

export interface SlackResult {
  readonly ok: boolean;
  /** Set when the transport did not run (no token) -- honest absence, never a silent no-op. */
  readonly skipped?: string;
  /** Set on a real failure (never thrown). */
  readonly error?: string;
  /** Message ts on a successful post (for threading). */
  readonly ts?: string;
  readonly channel?: string;
  /** File id on a successful upload. */
  readonly fileId?: string;
}

export type SlackFetch = (
  url: string,
  init?: any,
) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

function resolveFetch(fetchFn?: SlackFetch): SlackFetch {
  return fetchFn ?? ((fetch as unknown) as SlackFetch);
}

function resolveToken(env: NodeJS.ProcessEnv): string | undefined {
  const t = env.SLACK_BOT_TOKEN;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

/** chat.postMessage. threadTs threads the reply. Honest-skip tokenless. Never throws. */
export async function slackPostMessage(opts: {
  channel: string;
  text: string;
  blocks?: unknown[];
  threadTs?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: SlackFetch;
}): Promise<SlackResult> {
  const env = opts.env ?? process.env;
  const token = resolveToken(env);
  if (!token) return { ok: false, skipped: "no SLACK_BOT_TOKEN -- transport inactive" };
  const doFetch = resolveFetch(opts.fetchFn);
  try {
    const body: Record<string, unknown> = { channel: opts.channel, text: opts.text };
    if (opts.blocks) body.blocks = opts.blocks;
    if (opts.threadTs) body.thread_ts = opts.threadTs;
    const r = await doFetch(`${SLACK_API}/chat.postMessage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: `chat.postMessage HTTP ${r.status}` };
    const j = await r.json();
    if (!j?.ok) return { ok: false, error: `chat.postMessage: ${j?.error ?? "unknown error"}` };
    return { ok: true, ts: j.ts, channel: j.channel };
  } catch (e: any) {
    return { ok: false, error: `chat.postMessage error: ${e?.message ?? e}` };
  }
}

/**
 * The 3-step external-upload flow: files.getUploadURLExternal -> upload the bytes
 * (multipart POST, field name "file") -> files.completeUploadExternal. Reads bytes
 * from `path` (injectable readFileFn for tests). Dedups by default (channel|abspath|
 * size), matching the Apsis behavior: a re-run of an already-posted key skips the
 * network entirely and returns {ok:true}. Honest-skip tokenless. Never throws.
 */
export async function slackUploadFile(opts: {
  channel: string;
  path: string;
  title?: string;
  comment?: string;
  threadTs?: string;
  dedup?: boolean;
  ledgerPath?: string;
  env?: NodeJS.ProcessEnv;
  fetchFn?: SlackFetch;
  readFileFn?: (p: string) => Buffer;
}): Promise<SlackResult> {
  const env = opts.env ?? process.env;
  const token = resolveToken(env);
  if (!token) return { ok: false, skipped: "no SLACK_BOT_TOKEN -- transport inactive" };
  const dedup = opts.dedup ?? true;
  const readFileFn = opts.readFileFn ?? ((p: string) => readFileSync(p));
  let bytes: Buffer;
  let filename: string;
  try {
    bytes = readFileFn(opts.path);
    filename = opts.title ?? opts.path.split("/").pop() ?? opts.path;
  } catch (e: any) {
    return { ok: false, error: `read failed: ${e?.message ?? e}` };
  }
  const key = postedKey(opts.channel, opts.path);
  if (dedup && alreadyPosted(key, opts.ledgerPath)) {
    return { ok: true, channel: opts.channel };
  }
  const doFetch = resolveFetch(opts.fetchFn);
  try {
    const r1 = await doFetch(
      `${SLACK_API}/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${bytes.length}`,
      { method: "GET", headers: { Authorization: `Bearer ${token}` } },
    );
    if (!r1.ok) return { ok: false, error: `getUploadURLExternal HTTP ${r1.status}` };
    const j1 = await r1.json();
    if (!j1?.ok) return { ok: false, error: `getUploadURLExternal: ${j1?.error ?? "unknown error"}` };
    const uploadUrl: string = j1.upload_url;
    const fileId: string = j1.file_id;

    const fd = new FormData();
    fd.append("file", new Blob([new Uint8Array(bytes)]), filename);
    const r2 = await doFetch(uploadUrl, { method: "POST", body: fd });
    if (!r2.ok) return { ok: false, error: `upload POST HTTP ${r2.status}` };

    const body: Record<string, string> = {
      files: JSON.stringify([{ id: fileId, title: filename }]),
      channel_id: opts.channel,
    };
    if (opts.comment) body.initial_comment = opts.comment;
    if (opts.threadTs) body.thread_ts = opts.threadTs;
    const params = new URLSearchParams(body);
    const r3 = await doFetch(`${SLACK_API}/files.completeUploadExternal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${token}`,
      },
      body: params.toString(),
    });
    if (!r3.ok) return { ok: false, error: `completeUploadExternal HTTP ${r3.status}` };
    const j3 = await r3.json();
    if (!j3?.ok) return { ok: false, error: `completeUploadExternal: ${j3?.error ?? "unknown error"}` };
    if (dedup) recordPosted(key, opts.ledgerPath);
    return { ok: true, channel: opts.channel, fileId };
  } catch (e: any) {
    return { ok: false, error: `upload error: ${e?.message ?? e}` };
  }
}

/** "C..." id -> returned as-is; "#name" or "name" -> resolved via conversations.list. null if unresolvable. */
export async function resolveChannelId(
  nameOrId: string,
  opts?: { env?: NodeJS.ProcessEnv; fetchFn?: SlackFetch },
): Promise<string | null> {
  if (nameOrId.startsWith("C")) return nameOrId;
  const env = opts?.env ?? process.env;
  const token = resolveToken(env);
  if (!token) return null;
  const name = nameOrId.startsWith("#") ? nameOrId.slice(1) : nameOrId;
  const doFetch = resolveFetch(opts?.fetchFn);
  try {
    const r = await doFetch(`${SLACK_API}/conversations.list?limit=1000&types=public_channel,private_channel`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j?.ok) return null;
    const match = (j.channels ?? []).find((c: any) => c?.name === name);
    return match?.id ?? null;
  } catch {
    return null;
  }
}

/** Content-addressed dedup key: channel|abspath|size. Missing file -> size 0. */
export function postedKey(channel: string, path: string): string {
  const abspath = resolvePath(path);
  const len = existsSync(path) ? statSync(path).size : 0;
  return `${channel}|${abspath}|${len}`;
}

const DEFAULT_LEDGER = ".harness/slack-ledger.txt";

/** Whether `key` is already recorded in the ledger. Missing ledger -> false. Never throws. */
export function alreadyPosted(key: string, ledgerPath: string = DEFAULT_LEDGER): boolean {
  try {
    if (!existsSync(ledgerPath)) return false;
    return readFileSync(ledgerPath, "utf8").split("\n").includes(key);
  } catch {
    return false;
  }
}

/** Append `key` to the ledger, creating the parent dir + file if absent. Never throws. */
export function recordPosted(key: string, ledgerPath: string = DEFAULT_LEDGER): void {
  try {
    const dir = dirname(ledgerPath);
    if (dir && dir !== ".") mkdirSync(dir, { recursive: true });
    appendFileSync(ledgerPath, key + "\n");
  } catch {
    // a ledger write failure never blocks the caller -- dedup is best-effort.
  }
}
