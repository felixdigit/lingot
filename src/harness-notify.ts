import { slackPostMessage, type SlackFetch, type SlackResult } from "./harness-slack";

/**
 * Event -> channel routing + deterministic formatters (docs/harness/
 * slack-notify-map.md Section 4, Order H). The kernel holds the routing
 * defaults (which kind posts to worksite vs ops); a venture supplies its
 * channel IDs via the manifest `notify.slack` block and may trim the event
 * set. Formatters are pure string builders -- no LLM call, $0 tokens.
 */

export interface NotifyConfig {
  /** Channel id -- work outcomes + artefacts. */
  readonly worksite?: string;
  /** Channel id -- alerts (holds, drift, cost, failures). */
  readonly ops?: string;
  /** Venture may trim the kernel default event set. */
  readonly events?: readonly string[];
}

export type NotifyKind = "dispatch" | "artefact" | "gate-held" | "drift" | "failure" | "digest";

/** The kernel default routing: dispatch/artefact -> worksite; gate-held/drift/failure/digest -> ops. */
const KIND_TARGET: Readonly<Record<NotifyKind, "worksite" | "ops">> = {
  dispatch: "worksite",
  artefact: "worksite",
  "gate-held": "ops",
  drift: "ops",
  failure: "ops",
  digest: "ops",
};

/**
 * Resolve the target channel id for a kind, or null if unrouted (unknown kind),
 * trimmed out by `cfg.events`, or the target channel is unset in the manifest.
 */
export function routeEvent(kind: NotifyKind, cfg: NotifyConfig): string | null {
  const target = KIND_TARGET[kind];
  if (!target) return null;
  if (cfg.events && !cfg.events.includes(kind)) return null;
  return cfg[target] ?? null;
}

export interface FormattedMessage {
  /** Plain-text fallback (Slack notifications/accessibility). */
  readonly text: string;
  /** Block Kit layout. */
  readonly blocks: object[];
}

/** Verdict -> emoji, per the order's spec. Falls back to no emoji for an unknown verdict. */
const VERDICT_EMOJI: Readonly<Record<string, string>> = {
  accepted: ":white_check_mark:",
  held: ":double_vertical_bar:",
  failed: ":x:",
  drift: ":warning:",
};

/** First non-empty line of `task`, trimmed, ellipsized past `max` chars. Deterministic, no LLM. */
export function summarizeTask(task: string, max = 150): string {
  const line = (task.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function headerBlock(text: string): object {
  return { type: "header", text: { type: "plain_text", text, emoji: true } };
}

function sectionBlock(text: string): object {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function contextBlock(text: string): object {
  return { type: "context", elements: [{ type: "mrkdwn", text }] };
}

export function formatDispatch(ev: {
  venture: string;
  task: string;
  tier: string;
  costUsd?: number;
  verdict?: string;
  tools?: string[];
  ctxTokens?: number;
  memTokens?: number;
}): FormattedMessage {
  const emoji = VERDICT_EMOJI[ev.verdict ?? ""] ?? "";
  const summary = summarizeTask(ev.task);
  const textParts = [`[${ev.venture}] dispatch: ${summary}`, `tier ${ev.tier}`];
  if (ev.verdict) textParts.push(`verdict ${ev.verdict}`);
  if (ev.costUsd !== undefined) textParts.push(`$${ev.costUsd.toFixed(4)}`);
  if (ev.ctxTokens !== undefined) textParts.push(`ctx ${ev.ctxTokens}tok`);
  if (ev.memTokens !== undefined) textParts.push(`mem ${ev.memTokens}tok`);
  if (ev.tools && ev.tools.length) textParts.push(`tools: ${ev.tools.join(", ")}`);
  const text = textParts.join(" -- ");

  const contextParts = [`tier \`${ev.tier}\``];
  if (ev.costUsd !== undefined) contextParts.push(`$${ev.costUsd.toFixed(4)}`);
  if (ev.tools && ev.tools.length) contextParts.push(`tools: ${ev.tools.join(", ")}`);
  if (ev.ctxTokens !== undefined) contextParts.push(`ctx ${ev.ctxTokens}tok`);
  if (ev.memTokens !== undefined) contextParts.push(`mem ${ev.memTokens}tok`);

  const blocks = [
    headerBlock(`${emoji} ${ev.venture} · dispatch`.trim()),
    sectionBlock(summary),
    contextBlock(contextParts.join(" · ")),
  ];
  return { text, blocks };
}

export function formatArtefact(ev: { venture: string; path: string; caption?: string }): FormattedMessage {
  const base = `[${ev.venture}] artefact: ${ev.path}`;
  const text = ev.caption ? `${base} -- ${ev.caption}` : base;
  const blocks = [
    sectionBlock(`*${ev.venture}* · artefact: \`${ev.path}\``),
    ...(ev.caption ? [contextBlock(ev.caption)] : []),
  ];
  return { text, blocks };
}

export function formatGateHeld(ev: { venture: string; op: string; commandPreview?: string }): FormattedMessage {
  const base = `[${ev.venture}] gate-held: ${ev.op}`;
  const text = ev.commandPreview ? `${base} -- ${ev.commandPreview}` : base;
  const blocks: object[] = [
    headerBlock(`${VERDICT_EMOJI.held} ${ev.venture} · HOLD: ${ev.op}`),
    ...(ev.commandPreview ? [sectionBlock(`\`\`\`${ev.commandPreview}\`\`\``)] : []),
    contextBlock(`react ${VERDICT_EMOJI.accepted} to approve · ${VERDICT_EMOJI.failed} to decline`),
  ];
  return { text, blocks };
}

export function formatDrift(ev: {
  venture: string;
  suite: string;
  baselineRate?: number;
  recentRate?: number;
  revokedGates?: string[];
  recompileVerdict?: string;
}): FormattedMessage {
  const textParts = [`[${ev.venture}] drift: ${ev.suite}`];
  if (ev.baselineRate !== undefined && ev.recentRate !== undefined) {
    textParts.push(`${ev.baselineRate.toFixed(2)} -> ${ev.recentRate.toFixed(2)}`);
  }
  if (ev.revokedGates && ev.revokedGates.length) textParts.push(`revoked: ${ev.revokedGates.join(", ")}`);
  if (ev.recompileVerdict) textParts.push(`recompile: ${ev.recompileVerdict}`);
  const text = textParts.join(" -- ");

  const contextParts: string[] = [];
  if (ev.baselineRate !== undefined && ev.recentRate !== undefined) {
    contextParts.push(`${ev.baselineRate.toFixed(2)} -> ${ev.recentRate.toFixed(2)}`);
  }
  if (ev.revokedGates && ev.revokedGates.length) contextParts.push(`revoked: ${ev.revokedGates.join(", ")}`);
  if (ev.recompileVerdict) contextParts.push(`recompile: ${ev.recompileVerdict}`);

  const blocks = [
    headerBlock(`${VERDICT_EMOJI.drift} ${ev.venture} · drift: ${ev.suite}`),
    contextBlock(contextParts.join(" · ")),
  ];
  return { text, blocks };
}

export function formatFailure(ev: { venture: string; what: string; why: string }): FormattedMessage {
  const text = `[${ev.venture}] failure: ${ev.what} -- ${ev.why}`;
  const blocks = [
    headerBlock(`${VERDICT_EMOJI.failed} ${ev.venture} · failure`),
    sectionBlock(ev.what),
    contextBlock(ev.why),
  ];
  return { text, blocks };
}

export function formatDigest(ev: {
  venture: string;
  costPerAccepted?: number;
  accepted?: number;
  failed?: number;
  revocations?: string[];
}): FormattedMessage {
  const textParts = [`[${ev.venture}] digest`];
  if (ev.accepted !== undefined) textParts.push(`accepted ${ev.accepted}`);
  if (ev.failed !== undefined) textParts.push(`failed ${ev.failed}`);
  if (ev.costPerAccepted !== undefined) textParts.push(`cost/accepted $${ev.costPerAccepted.toFixed(4)}`);
  if (ev.revocations && ev.revocations.length) textParts.push(`revocations: ${ev.revocations.join(", ")}`);
  const text = textParts.join(" -- ");

  const contextParts: string[] = [];
  if (ev.accepted !== undefined) contextParts.push(`accepted ${ev.accepted}`);
  if (ev.failed !== undefined) contextParts.push(`failed ${ev.failed}`);
  if (ev.costPerAccepted !== undefined) contextParts.push(`cost/accepted $${ev.costPerAccepted.toFixed(4)}`);
  if (ev.revocations && ev.revocations.length) contextParts.push(`revocations: ${ev.revocations.join(", ")}`);

  const blocks = [sectionBlock(`*${ev.venture}* · digest`), contextBlock(contextParts.join(" · "))];
  return { text, blocks };
}

const FORMATTERS: Readonly<Record<NotifyKind, (ev: any) => FormattedMessage>> = {
  dispatch: formatDispatch,
  artefact: formatArtefact,
  "gate-held": formatGateHeld,
  drift: formatDrift,
  failure: formatFailure,
  digest: formatDigest,
};

/**
 * Route + format + post. Honest-skip tokenless (via slackPostMessage). Fire-and-
 * forget friendly: returns a promise, never throws. An unrouted/trimmed/unset
 * kind is a no-op skip, not an error -- notify is best-effort by design.
 */
export async function notify(
  ev: { kind: NotifyKind; venture: string; [k: string]: unknown },
  cfg: NotifyConfig,
  opts?: { env?: NodeJS.ProcessEnv; fetchFn?: SlackFetch },
): Promise<SlackResult> {
  const channel = routeEvent(ev.kind, cfg);
  if (!channel) return { ok: false, skipped: `event "${ev.kind}" unrouted, trimmed, or channel unset` };
  const formatter = FORMATTERS[ev.kind];
  const { text, blocks } = formatter(ev);
  return slackPostMessage({ channel, text, blocks, env: opts?.env, fetchFn: opts?.fetchFn });
}
