import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadHarnessManifest } from "./harness-manifest";
import { resolveProject } from "./harness-merge";
import { KERNEL_DEFAULTS, KERNEL_GATE_PATTERNS, KERNEL_TIER_REGISTRY } from "./harness-kernel";
import { recordDispatch, costFromUsage } from "./harness-usage";
import { tierEnv } from "./harness-dispatch";
import { compiledContextFor, retrievedMemory } from "./harness-context";
import { railsActive, moderationCheck } from "./harness-rails";

/**
 * The harness EXECUTOR (Phase 1, docs/harness/runtime-build.md L3 core). The
 * spine of the running harness: it runs a manifest task as a real autonomous
 * agent and returns the result. Everything else plugs in here -- routing picks
 * the model (L2), the tool allow-list is the deny-by-default gate (L4/L8),
 * per-turn usage is the real cost meter (L6).
 *
 * ENGINE: the headless `claude` CLI (`claude -p`), NOT the Agent SDK. This is
 * deliberate and load-bearing -- the CLI bills against the Claude MAX
 * SUBSCRIPTION, while the SDK's query() bills API credits. So the premium
 * Anthropic loop runs on the subscription (free at point of use); we strip
 * ANTHROPIC_API_KEY/BASE_URL from the spawn env so it cannot fall to credit
 * billing. Cheap/extra tiers (Z.ai, RunPod) are the ONLY metered spend, reached
 * by putting the tier env in front of the same CLI -- that is Phase 2.
 *
 * The gate: a PreToolUse hook (harness-tool-gate.sh, wired via --settings,
 * fail-closed if absent) enforces deny-by-default tools (HARNESS_ALLOW), the
 * governance gate wall (HARNESS_HOLD), the self-protection floor, and the
 * lethal-trifecta floor -- and records every decision to the audit trail.
 */

export interface ExecResult {
  readonly text: string;
  readonly costUsd: number;
  readonly inTokens: number;
  readonly outTokens: number;
  readonly turns: number;
  /** Tools the agent actually invoked (all within the allow-set; others were gate-denied). */
  readonly toolCalls: readonly string[];
  /** The tier it ran on, and whether that tier was metered (cheap) vs the subscription. */
  readonly tier: string;
  readonly metered: boolean;
  /** Governance ops held (not cleared) for this run -- founder clears with --clear. */
  readonly heldOps: readonly string[];
  /** Context visibility: compiled-contract tokens + retrieved-memory tokens fed to the run. */
  readonly ctxTokens: number;
  readonly memTokens: number;
  /** Output-rail verdict when flagged (categories); undefined = clean or rail inactive. */
  readonly railFlagged?: readonly string[];
  readonly exit: number;
}

export interface ExecOptions {
  /** Tier to run the whole task on (else routing.default). Anthropic tiers -> subscription; cheap tiers -> metered. */
  readonly tier?: string;
  /** Override the model (else derived from the tier). "opus" | "sonnet" | "haiku" | full id. */
  readonly model?: string;
  /** Restrict the tool set (L4). Omit = safe baseline + manifest allow. e.g. ["Read","Glob"] read-only. */
  readonly allowedTools?: readonly string[];
  /** Governance ops the founder clears for THIS run (L8). Gated ops not cleared are held at the tool boundary. */
  readonly clear?: readonly string[];
  /** Deliberate override of invariant 7 (cheap tiers get text-labor only, never the agentic loop). */
  readonly unsafeCheapAgentic?: boolean;
  /** Hard wall-clock cap on the run (ms). Default 5 min. */
  readonly timeoutMs?: number;
}

/** Map a routing tier alias to a subscription model. Cheap tiers fall back here (Phase 2 routes them via env). */
export function tierToModel(alias?: string): string {
  switch (alias) {
    case "reason": return "opus";
    case "scoped": return "sonnet";
    case "mechanical": return "haiku";
    default: return "sonnet";
  }
}

// Read-only baseline. WebFetch/WebSearch are NOT here (audit M4): untrusted-web
// ingress is the injection vector and the input rails are not yet adopted -- a
// venture grants them explicitly via tools.permissions.allow when it needs them.
const SAFE_BASELINE = ["Read", "Glob", "Grep", "LS", "TodoWrite", "NotebookRead"];

/**
 * Default-deny env passthrough (L8 capability level): a worker gets ONLY what a
 * claude subprocess needs to run -- system basics + HARNESS_* -- never the
 * studio's secrets (ZAI/RUNPOD/LITELLM/... sit in the parent env; a
 * prompt-injected worker could exfiltrate them, and the command-pattern gate is
 * a tripwire, not a wall). Subscription auth comes from the CLI's own keychain
 * config via HOME, not from env. External tiers re-add exactly their trio.
 */
const ENV_ALLOW_EXACT = new Set([
  "PATH", "HOME", "SHELL", "TMPDIR", "USER", "LOGNAME", "TERM", "LANG", "COLORTERM",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
]);
const ENV_ALLOW_PREFIX = ["LC_", "HARNESS_", "XDG_", "CLAUDE_"];

export function workerEnv(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (ENV_ALLOW_EXACT.has(k) || ENV_ALLOW_PREFIX.some((p) => k.startsWith(p))) out[k] = v;
  }
  return out;
}

export async function executeTask(manifestPath: string, task: string, opts: ExecOptions = {}): Promise<ExecResult> {
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) throw new Error(`harness exec: ${load.errors.join("; ")}`);
  const res = resolveProject(KERNEL_DEFAULTS, load.manifest);
  if (!res.resolved) throw new Error(`harness exec: ${res.errors.join("; ")}`);
  const resolved = res.resolved;
  const anchor = dirname(manifestPath);

  const tier = opts.tier ?? resolved.routing?.default ?? KERNEL_DEFAULTS.routing?.default ?? "scoped";
  const te = tierEnv(tier);
  if (te.missing && te.missing.length) {
    throw new Error(`harness exec: tier "${tier}" not runnable here -- missing ${te.missing.join(", ")}`);
  }
  const external = !!te.env?.ANTHROPIC_BASE_URL;
  // Invariant 7 (routing-and-verify.md, audit H2): cheap labor-lane tiers get
  // TEXT-labor only -- never the agentic tool loop. `harness route`/`ask` are the
  // labor surfaces; an agentic run on a labor tier needs a deliberate override.
  if (external && KERNEL_TIER_REGISTRY[tier]?.role === "labor" && !opts.unsafeCheapAgentic) {
    throw new Error(
      `harness exec: tier "${tier}" is a labor-lane (text-only) tier -- an agentic run violates invariant 7; use \`harness route\`/\`ask\` for labor, or pass --unsafe-cheap-agentic to override deliberately`,
    );
  }
  const model = opts.model ?? (external ? te.env?.ANTHROPIC_MODEL ?? "" : tierToModel(tier));
  const denySet = new Set(resolved.tools?.permissions?.deny ?? []);
  // WebFetch/WebSearch rejoin the baseline ONLY while the I/O rail is active
  // (M4 posture: untrusted-web ingress stays off until a rail guards it).
  const webTools = railsActive() ? ["WebFetch", "WebSearch"] : [];
  const allowList = (opts.allowedTools
    ? [...opts.allowedTools]
    : [...SAFE_BASELINE, ...webTools, ...(resolved.tools?.permissions?.allow ?? [])]
  ).filter((t) => !denySet.has(t));

  // The real deny-by-default gate: a PreToolUse hook (harness-tool-gate.sh) that
  // reads HARNESS_ALLOW and returns an explicit allow/deny for every tool.
  // --allowedTools alone does NOT enforce deny-by-default in headless mode.
  const gatePath = fileURLToPath(new URL("../harness-tool-gate.sh", import.meta.url));
  // FAIL-CLOSED (audit C1): a missing gate script must abort the run, never run
  // ungated -- a silently absent gate is worse than no gate, because it is claimed.
  if (!existsSync(gatePath)) {
    throw new Error(`harness exec: tool gate missing at ${gatePath} -- refusing to run ungated (fail-closed)`);
  }
  const settings = JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `bash ${gatePath}` }] }] },
  });

  const args = ["-p", task, "--output-format", "stream-json", "--verbose", "--model", model, "--settings", settings];

  // L1: the venture's COMPILED operating contract drives the run (budgeted; the
  // manifest is the control plane, not whatever a session happens to load).
  // L5: the venture's declared retrieval command runs HERE (parent env holds the
  // creds), and only its TEXT reaches the worker. One combined append.
  const ctx = compiledContextFor(anchor);
  const mem = retrievedMemory(anchor, resolved.state?.memory?.retrieval, task);
  const contextParts: string[] = [];
  if (ctx.text) contextParts.push(`[harness/v1 compiled context -- the venture operating contract]\n\n${ctx.text}`);
  if (mem.text) contextParts.push(`[harness/v1 retrieved memory -- venture brain, query = the task]\n\n${mem.text}`);
  if (contextParts.length) args.push("--append-system-prompt", contextParts.join("\n\n---\n\n"));

  // Governance gate wall (L8): the manifest's gated ops that this run did NOT
  // clear are HELD -- their command patterns deny the tool at the boundary.
  const gated = resolved.governance?.gated ?? [];
  const cleared = new Set(opts.clear ?? []);
  const held = gated.filter((op) => !cleared.has(op));
  // A held op with no enforcement pattern would be CLAIMED-held but unenforced
  // (audit M1) -- refuse rather than pretend.
  const unenforceable = held.filter((op) => !KERNEL_GATE_PATTERNS[op]);
  if (unenforceable.length) {
    throw new Error(
      `harness exec: gated op(s) with no enforcement pattern: ${unenforceable.join(", ")} -- add KERNEL_GATE_PATTERNS entries (or clear them explicitly); refusing to claim an unenforceable hold`,
    );
  }
  const holdPattern = held.map((op) => KERNEL_GATE_PATTERNS[op]).filter(Boolean).join("|");

  // Billing: an Anthropic tier strips any override -> runs on the Max
  // subscription (free at point of use); a cheap tier applies its env (base URL +
  // token) -> metered, the only paid spend. HARNESS_ALLOW + HARNESS_HOLD feed the gate hook.
  // L8 audit trail + lethal-trifecta state, both per-run under the venture's .harness.
  const harnessDir = join(anchor, ".harness");
  try { mkdirSync(harnessDir, { recursive: true }); } catch { /* best-effort */ }
  const auditPath = join(harnessDir, "audit.jsonl");
  // Per-run trifecta state (audit M6): pid-scoped so concurrent runs on one
  // venture cannot contaminate each other's private/untrusted flags.
  const trifectaPath = join(harnessDir, `trifecta.${process.pid}.state`);
  try { writeFileSync(trifectaPath, ""); } catch { /* best-effort -- fresh state each run */ }
  // Default-deny env (L8): system basics + HARNESS_* only; no studio secrets.
  // An Anthropic tier authenticates via the CLI's own config (HOME), never env;
  // an external tier re-adds exactly its trio (base URL + token + model).
  const env: NodeJS.ProcessEnv = {
    ...workerEnv(process.env),
    HARNESS_ALLOW: allowList.join(","),
    HARNESS_AUDIT: auditPath,
    HARNESS_TRIFECTA: trifectaPath,
    HARNESS_RUN_ID: String(process.pid),
    ...(holdPattern ? { HARNESS_HOLD: holdPattern } : {}),
  };
  if (external) Object.assign(env, te.env);

  const r = spawnSync("claude", args, {
    cwd: anchor,
    encoding: "utf8",
    env,
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeoutMs ?? 300_000,
  });

  const toolCalls: string[] = [];
  const seenMsgIds = new Set<string>();
  let text = "";
  let inTokens = 0;
  let outTokens = 0;
  let costUsd = 0;
  let costAccum = 0;
  let turns = 0;
  let exit = r.status ?? (r.error ? 1 : 0);

  for (const line of (r.stdout ?? "").split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev: any;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (ev.type === "assistant") {
      // Tool calls are collected from EVERY event (duplicate events can carry the
      // parallel tool_use blocks -- the dedup below must not lose them).
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "tool_use") toolCalls.push(String(b.name));
      }
      // Parallel tool calls emit events sharing one message.id -- dedupe so
      // turns/tokens/cost/text are not double-counted (audit M2).
      const mid = ev.message?.id;
      if (mid && seenMsgIds.has(mid)) continue;
      if (mid) seenMsgIds.add(mid);
      turns += 1;
      for (const b of ev.message?.content ?? []) {
        if (b?.type === "text") text += b.text;
      }
      const u = ev.message?.usage;
      if (u) {
        inTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        outTokens += u.output_tokens ?? 0;
        costAccum += costFromUsage(u, KERNEL_TIER_REGISTRY[tier]?.price);
      }
    } else if (ev.type === "result") {
      // Prefer the CLI's own estimate; fall back to the cache-aware accumulation.
      costUsd = ev.total_cost_usd ?? costAccum;
      if (typeof ev.result === "string" && ev.result) text = ev.result;
      // Usage fallback: some endpoints (Z.ai) don't populate per-turn usage the
      // way Claude does, but the result event may carry a usage total.
      if ((inTokens === 0 || outTokens === 0) && ev.usage) {
        inTokens = inTokens || (ev.usage.input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0);
        outTokens = outTokens || (ev.usage.output_tokens ?? 0);
      }
      if (ev.is_error || (ev.subtype && ev.subtype !== "success")) exit = exit || 1;
    }
  }

  if (r.error) {
    text = text || `ERR: ${(r.error as Error).message}`;
    exit = 1;
  }
  if (!text && (r.stderr ?? "").trim()) {
    text = `ERR: ${(r.stderr as string).trim().slice(0, 300)}`;
    exit = exit || 1;
  }
  if (!costUsd && costAccum) costUsd = costAccum; // no result event (e.g. timeout) -- keep the accumulated estimate
  try { rmSync(trifectaPath, { force: true }); } catch { /* best-effort */ }

  // Output rail (17): an agentic run's final text is a shipping surface too.
  // Flagged -> loud + non-zero exit; the text still returns (Felix may need to
  // see WHAT was flagged) but nothing downstream should treat it as clean.
  let railFlagged: string[] | undefined;
  if (railsActive() && text) {
    const rv = await moderationCheck(text);
    if (rv.flagged) {
      railFlagged = [...rv.categories];
      exit = exit || 1;
    }
  }

  recordDispatch(anchor, {
    at: new Date().toISOString(),
    tier,
    provider: external ? "metered" : "anthropic (subscription)",
    model,
    // The registry's role is the truth (audit L1) -- mechanical is labor even on the subscription.
    role: KERNEL_TIER_REGISTRY[tier]?.role ?? (external ? "labor" : "judgment"),
    exit,
    inTokens,
    outTokens,
    costUsd,
  });

  return {
    text, costUsd, inTokens, outTokens, turns, toolCalls, tier, metered: external, heldOps: held,
    ctxTokens: ctx.tokens, memTokens: mem.tokens, ...(railFlagged ? { railFlagged } : {}), exit,
  };
}
