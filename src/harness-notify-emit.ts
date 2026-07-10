import { dirname } from "node:path";
import { loadHarnessManifest } from "./harness-manifest";
import { notify, type NotifyConfig } from "./harness-notify";
import { slackUploadFile, type SlackFetch } from "./harness-slack";
import { detectNewArtefacts } from "./harness-artefact";
import { appendLedger } from "./harness-run-ledger";

/**
 * The parent-side emitter (Order I). Builds on Order H's notify()/slackUploadFile
 * -- this module is the CLI-runtime-boundary glue: load the venture's notify
 * config, build the event(s), post, thread any fresh artefacts under the
 * dispatch post. Every export here is called AWAITED, right before
 * `process.exit`, from a token-holding parent process (workers never post --
 * see docs/harness/orders/order-I-artefacts-emit.md). NEVER throws and NEVER
 * changes the caller's exit code -- a Slack hiccup is invisible to the run.
 *
 * Order J extends this layer: every ACTIONABLE post (dispatch, gate-held,
 * failure) that gets back a Slack `ts` also writes a run-ledger entry keyed by
 * that `ts` -- the Socket Mode listener (harness-slack-listen.ts) reads it back
 * to map a reaction/reply to the run + op it belongs to.
 */

export interface EmitOpts {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchFn?: SlackFetch;
  readonly repoRoot?: string;
}

function loadCfg(manifestPath: string): { venture: string; cfg: NotifyConfig } | null {
  const { manifest } = loadHarnessManifest(manifestPath);
  const cfg = manifest?.notify?.slack;
  if (!manifest || !cfg) return null;
  return { venture: manifest.identity.name, cfg };
}

/**
 * exec completion: dispatch to worksite, then any new artefacts THREADED under
 * the dispatch post, then gate-held (one per heldOp) + failure to ops as
 * applicable. `startMs` must be recorded (Date.now()) BEFORE the work ran, so
 * pre-existing uncommitted files never qualify (harness-artefact mtime-scope).
 */
export async function emitExecNotifications(
  manifestPath: string,
  startMs: number,
  result: {
    exit: number;
    heldOps: readonly string[];
    railFlagged?: readonly string[];
    tier: string;
    costUsd: number;
    ctxTokens?: number;
    memTokens?: number;
    toolCalls: readonly string[];
    task: string;
  },
  opts?: EmitOpts,
): Promise<void> {
  try {
    const loaded = loadCfg(manifestPath);
    if (!loaded) return;
    const { venture, cfg } = loaded;
    const env = opts?.env;
    const fetchFn = opts?.fetchFn;
    const repoRoot = opts?.repoRoot ?? process.cwd();
    const anchor = dirname(manifestPath);

    const dispatchRes = await notify(
      {
        kind: "dispatch",
        venture,
        task: result.task,
        tier: result.tier,
        costUsd: result.costUsd,
        verdict: result.exit === 0 ? "accepted" : "failed",
        tools: [...new Set(result.toolCalls)],
        ...(result.ctxTokens !== undefined ? { ctxTokens: result.ctxTokens } : {}),
        ...(result.memTokens !== undefined ? { memTokens: result.memTokens } : {}),
      },
      cfg,
      { env, fetchFn },
    );

    if (dispatchRes.ok && dispatchRes.ts) {
      appendLedger(anchor, {
        ts: dispatchRes.ts,
        channel: dispatchRes.channel ?? "",
        kind: "dispatch",
        dir: anchor,
        task: result.task,
        heldOps: result.heldOps,
        venture,
      });
      if (cfg.worksite) {
        const artefacts = detectNewArtefacts(repoRoot, startMs);
        for (const path of artefacts) {
          try {
            await slackUploadFile({ channel: cfg.worksite, path, threadTs: dispatchRes.ts, env, fetchFn });
          } catch {
            // one bad artefact never blocks the others.
          }
        }
      }
    }

    for (const op of result.heldOps) {
      try {
        const heldRes = await notify({ kind: "gate-held", venture, op }, cfg, { env, fetchFn });
        if (heldRes.ok && heldRes.ts) {
          appendLedger(anchor, {
            ts: heldRes.ts,
            channel: heldRes.channel ?? "",
            kind: "gate-held",
            dir: anchor,
            task: result.task,
            heldOps: [op],
            venture,
          });
        }
      } catch {
        // best-effort per held op.
      }
    }

    if (result.exit !== 0) {
      try {
        const failRes = await notify(
          { kind: "failure", venture, what: result.task, why: result.railFlagged?.length ? `rail flagged: ${result.railFlagged.join(",")}` : `exit ${result.exit}` },
          cfg,
          { env, fetchFn },
        );
        if (failRes.ok && failRes.ts) {
          appendLedger(anchor, {
            ts: failRes.ts,
            channel: failRes.channel ?? "",
            kind: "failure",
            dir: anchor,
            task: result.task,
            heldOps: result.heldOps,
            venture,
          });
        }
      } catch {
        // swallow -- see module doc.
      }
    }
  } catch {
    // belt-and-suspenders: emission never throws, never touches the exit code.
  }
}

/** route completion: accepted -> dispatch to worksite; rejected/escalation-failed -> failure to ops. */
export async function emitRouteNotifications(
  manifestPath: string,
  result: { accepted: boolean; tier: string; costUsd?: number; workType?: string },
  opts?: EmitOpts,
): Promise<void> {
  try {
    const loaded = loadCfg(manifestPath);
    if (!loaded) return;
    const { venture, cfg } = loaded;
    const env = opts?.env;
    const fetchFn = opts?.fetchFn;
    const task = result.workType ?? "route";

    if (result.accepted) {
      await notify(
        { kind: "dispatch", venture, task, tier: result.tier, verdict: "accepted", ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) },
        cfg,
        { env, fetchFn },
      );
    } else {
      await notify({ kind: "failure", venture, what: task, why: `route rejected on tier ${result.tier}` }, cfg, { env, fetchFn });
    }
  } catch {
    // never throws.
  }
}

/** drift detection/response: always posts to ops (drift is an alert-class event). */
export async function emitDriftNotifications(
  manifestPath: string,
  result: {
    suite: string;
    baselineRate?: number;
    recentRate?: number;
    revokedGates?: readonly string[];
    recompileVerdict?: string;
  },
  opts?: EmitOpts,
): Promise<void> {
  try {
    const loaded = loadCfg(manifestPath);
    if (!loaded) return;
    const { venture, cfg } = loaded;
    await notify(
      {
        kind: "drift",
        venture,
        suite: result.suite,
        ...(result.baselineRate !== undefined ? { baselineRate: result.baselineRate } : {}),
        ...(result.recentRate !== undefined ? { recentRate: result.recentRate } : {}),
        ...(result.revokedGates ? { revokedGates: result.revokedGates } : {}),
        ...(result.recompileVerdict ? { recompileVerdict: result.recompileVerdict } : {}),
      },
      cfg,
      { env: opts?.env, fetchFn: opts?.fetchFn },
    );
  } catch {
    // never throws.
  }
}
