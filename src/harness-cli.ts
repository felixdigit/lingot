import { existsSync, statSync, writeFileSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Load the repo-root .env into process.env so machine-local secrets pasted there
 * (ZAI_API_KEY, LITELLM_*, ...) are seen by the resolver -- no `export` needed.
 * Minimal parser, no dependency; never overrides an already-set env var; strips
 * surrounding quotes; ignores comments/blanks. Missing .env is fine.
 */
function loadDotEnv(): void {
  try {
    const text = readFileSync(join(process.cwd(), ".env"), "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) continue;
      let val = m[2];
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined && val !== "") process.env[m[1]] = val;
    }
  } catch {
    /* no .env at cwd -- fine */
  }
}
loadDotEnv();
import { adopt } from "./harness-adopt";
import { tierEnv, formatTierEnv, measuredClaudeRun, leanRun } from "./harness-dispatch";
import { formatVerdict } from "./harness-verdict";
import { doctorProject, formatHarnessDoctorReport } from "./harness-doctor";
import { resolveLock, formatLock } from "./harness-lock";
import { recordGatePass } from "./harness-gates";
import { runEval, formatEvalReport, proveTier, formatTierProof } from "./harness-eval";
import { detectDrift, respondToDrift } from "./harness-drift";
import { runPlan, formatPlanResult } from "./harness-plan";
import { fireEligible } from "./harness-cron";
import { driftCycle, sweepDrift } from "./harness-recompile";
import { railsActive, moderationCheck } from "./harness-rails";
import { recordDispatch, readUsage, summarizeUsage, formatUsage } from "./harness-usage";
import { KERNEL_TIER_REGISTRY, KERNEL_DEFAULTS, expandToolPresets } from "./harness-kernel";
import { loadHarnessManifest } from "./harness-manifest";
import { resolveProject } from "./harness-merge";
import { formatAutomations, fireAutomation } from "./harness-automate";
import { executeTask } from "./harness-exec";
import { routeVerified, parseCheck, runCheck, formatRouteResult } from "./harness-route";
import { emitExecNotifications, emitRouteNotifications, emitDriftNotifications, emitCommitNotification } from "./harness-notify-emit";
import { resolveChannelId, slackUploadFile } from "./harness-slack";
import { runListener } from "./harness-slack-listen";
import { runPromptGate, formatPromptGateReport } from "./harness-prompt-gate";
import { tidy, formatTidyResult } from "./harness-hygiene";
import { lintKernelSources, lintAgentsMd, formatLintFindings } from "./harness-lint";

/**
 * The harness CLI (Phase 0, 0.3c) -- the terminal operator surface
 * (docs/harness/90). Successor-in-progress to the lingot CLI. Called ON a
 * project. Phase 0 verbs:
 *
 *   harness boot  <dir|manifest> [--dry]   adopt (materialize + verdict); --dry = verdict only, no write
 *   harness adopt <dir|manifest>           materialize shadow -> live + verdict
 *
 * A project dir is expected to carry a harness.json (harness/v1). YAML support
 * is a follow-on (the yaml dep exists); Phase 0 reads JSON, consistent with the
 * existing lingot.json manifests.
 */

// Resolved the same way harness-compile.ts resolves its own KERNEL_DIR --
// this file and that one are siblings under engine/lingot/src/, so the
// identical expression lands on the identical kernel directory.
const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel");

function usage(): never {
  console.log(
    [
      "usage:",
      "  harness boot <dir|manifest> [--dry]",
      "  harness adopt <dir|manifest>",
      "  harness doctor <dir|manifest>",
      "  harness lint [dir]   (deterministic prompt-quality lint -- kernel sources + AGENTS.md at dir; default \".\")",
      "  harness prompt-gate <dir> <suite> [--calibrate] [--trials <n>] [--allow-cost] [--baseline <ref>]   (paired A/B eval on a prompt-artifact change)",
      "  harness lock <dir|manifest>",
      "  harness gate-pass <dir|manifest> <suite> [--by <who>]",
      "  harness eval <dir|manifest> <suite> [--tier <default>]",
      "  harness prove-tier <dir|manifest> <workType> <tier> [--threshold <0-1>]   (earn the tier_swap gate)",
      "  harness drift <dir|manifest> <suite>|--all [--window <n>] [--drop <0-1>] [--respond|--recompile]   (decay -> revoke -> re-materialize)",
      "  harness automate <dir|manifest> [--fire <name>] [--fire-eligible]",
      "  harness plan <dir|manifest> <plan.jsonl> [--concurrency <n>]   (multi-unit verified routing)",
      "  harness exec <dir|manifest> \"<task>\" [--tier <alias>] [--model <m>] [--tools <A,B|read|build|research>]   (run on the executor; --tools presets expand: read|build|research)",
      "  harness route <dir|manifest> --work-type <X> --check <spec> [--tier <cheap>] \"<prompt>\"   (verified labor routing)",
      "  harness run --tier <alias> [\"<prompt>\"] [--dry] [-- <cmd...>]   (full Claude Code on the tier)",
      "  harness ask --tier <alias> \"<prompt>\"                          (lean: direct model call, no agent context)",
      "  harness batch --tier <alias> --file <tasks.txt> [--out <dir>]   (lean fan-out)",
      "  harness usage [dir] [--fleet] [--tail <n>]   (spend + accepted, per tier / per venture / last n)",
      "  harness audit [dir] [--tail <n>]   (the gate's allow/deny/held decision trail)",
      '  harness post <file> [--channel <C...|#name|worksite|ops|telemetry>] [--say "caption"] [--dir <venture>]   (post a file to Slack)',
      "  harness slack listen [dir]   (Socket Mode two-way listener -- fail-closed w/o SLACK_APP_TOKEN + SLACK_OPERATOR_ID)",
      "  harness tidy [dir] [--apply] [--include-gone]   (SAFE janitor -- dry-run by default; git branch -d + git worktree prune only)",
      "  harness notify-commit [dir] [--sha <sha>]   (post HEAD, or --sha, to worksite; fail-soft hook helper -- see .husky/post-commit)",
    ].join("\n"),
  );
  process.exit(2);
}

/** Resolve a project argument to a manifest file path. */
function resolveManifestPath(arg: string): string | null {
  if (!existsSync(arg)) return null;
  if (statSync(arg).isDirectory()) {
    const p = join(arg, "harness.json");
    return existsSync(p) ? p : null;
  }
  return arg;
}

const args = process.argv.slice(2);
const command = args[0];
const positional = args.slice(1).filter((a) => !a.startsWith("--"));
const flags = new Set(args.filter((a) => a.startsWith("--")));

if (command === "boot" || command === "adopt") {
  const target = positional[0];
  if (!target) usage();
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target} (expected a harness.json, or a dir containing one)`);
    process.exit(1);
  }
  const write = command === "adopt" || !flags.has("--dry");
  const result = adopt(manifestPath, { write });

  if (!result.verdict) {
    console.error(`harness ${command}: manifest did not resolve:`);
    for (const e of result.errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(formatVerdict(result.verdict));
  if (write && result.written.length > 0) {
    console.log(`  materialized: ${result.written.length} file(s)`);
  }
  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(`  materialize error: ${e}`);
    process.exit(1);
  }
  process.exit(result.verdict.level === "BLOCKED" ? 1 : 0);
} else if (command === "doctor") {
  const target = positional[0];
  if (!target) usage();
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target} (expected a harness.json, or a dir containing one)`);
    process.exit(1);
  }
  const report = doctorProject(manifestPath);
  console.log(formatHarnessDoctorReport(report));
  process.exit(report.verdict === "red" ? 1 : 0);
} else if (command === "lint") {
  // Deterministic prompt-quality lint (research/responses/195-response.md --
  // these checks live in compiler code, never delegated to a model). Scope:
  // the kernel's own prompt units, plus the compiled AGENTS.md at the target
  // anchor (default ".") when one exists on disk.
  const anchor = positional[0] ?? ".";
  const agentsPath = join(anchor, "AGENTS.md");
  const findings = [
    ...lintKernelSources(KERNEL_DIR),
    ...(existsSync(agentsPath) ? lintAgentsMd(agentsPath, readFileSync(agentsPath, "utf8")) : []),
  ];
  console.log(formatLintFindings(findings));
  process.exit(findings.some((f) => f.severity === "error") ? 1 : 0);
} else if (command === "prompt-gate") {
  // The eval-gated prompt-change loop (docs/harness/prompt-design.md P7): a
  // paired A/B of the committed baseline vs the working tree on the suite's
  // bound artifact. SHIP-OK records prompt:<suite> in the gate ledger; every
  // run appends to the drift history so decay revokes stale passes.
  const anchor = positional[0];
  const suiteName = positional[1];
  if (!anchor || !suiteName) {
    console.error("usage: harness prompt-gate <dir> <suite> [--calibrate] [--trials <n>] [--allow-cost] [--baseline <ref>]");
    process.exit(2);
  }
  const tIdx = args.indexOf("--trials");
  const bIdx = args.indexOf("--baseline");
  const report = await runPromptGate(anchor, suiteName, {
    calibrate: flags.has("--calibrate"),
    allowCost: flags.has("--allow-cost"),
    ...(tIdx !== -1 ? { trials: parseInt(args[tIdx + 1], 10) || undefined } : {}),
    ...(bIdx !== -1 && args[bIdx + 1] ? { baselineRef: args[bIdx + 1] } : {}),
  });
  console.log(formatPromptGateReport(report));
  process.exit(report.verdict === "SHIP-OK" || report.verdict === "NO-CHANGE" || report.verdict === "CALIBRATE" ? 0 : 1);
} else if (command === "lock") {
  const target = positional[0];
  if (!target) usage();
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target} (expected a harness.json, or a dir containing one)`);
    process.exit(1);
  }
  const { lock, errors } = resolveLock(manifestPath);
  if (!lock) {
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const lockPath = join(dirname(manifestPath), "harness.lock");
  writeFileSync(lockPath, formatLock(lock));
  console.log(`locked ${lock.project}: pin ${lock.pin} -> kernel ${lock.kernel}`);
  console.log(`  wrote ${lockPath}`);
  process.exit(0);
} else if (command === "gate-pass") {
  const target = positional[0];
  const suite = positional[1];
  if (!target || !suite) usage();
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const byIdx = args.indexOf("--by");
  const by = byIdx !== -1 ? args[byIdx + 1] : undefined;
  recordGatePass(dirname(manifestPath), suite, by);
  console.log(`gate-pass recorded: ${suite}${by ? ` (by ${by})` : ""}`);
  process.exit(0);
} else if (command === "run") {
  const tierIdx = args.indexOf("--tier");
  const alias = tierIdx !== -1 ? args[tierIdx + 1] : undefined;
  if (!alias) usage();
  const resolved = tierEnv(alias);
  if (resolved.missing && resolved.missing.length > 0) {
    console.error(formatTierEnv(resolved));
    process.exit(1);
  }
  if (flags.has("--dry")) {
    console.log(formatTierEnv(resolved));
    process.exit(0);
  }
  // What to run on the tier: an explicit command after `--`, else a Claude Code
  // session on the positional prompt (headless `claude -p <prompt>` with a
  // prompt, interactive `claude` without).
  const sep = args.indexOf("--");
  let cmd: string[];
  if (sep !== -1) {
    cmd = args.slice(sep + 1);
  } else {
    const promptArgs: string[] = [];
    for (let i = 1; i < args.length; i++) {
      if (args[i] === "--tier") { i++; continue; }
      if (args[i].startsWith("--")) continue;
      promptArgs.push(args[i]);
    }
    const prompt = promptArgs.join(" ").trim();
    cmd = prompt ? ["claude", "-p", prompt] : ["claude"];
  }
  if (cmd.length === 0) {
    console.log(formatTierEnv(resolved));
    process.exit(0);
  }
  const t = KERNEL_TIER_REGISTRY[alias!];
  const env: NodeJS.ProcessEnv = { ...process.env, ...resolved.env };
  // Billing consistency (audit H4): an Anthropic-native tier runs on the Max
  // subscription -- strip any key so `run` can never silently bill credits.
  if (!resolved.env?.ANTHROPIC_BASE_URL) {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  const base = { at: new Date().toISOString(), tier: alias!, provider: t?.provider ?? "?", model: t?.model ?? "?", role: (t?.role ?? "labor") as "judgment" | "labor" };

  // Measured path: the ergonomic `claude -p <prompt>` run -- capture usage + cost.
  if (sep === -1 && cmd[0] === "claude" && cmd[1] === "-p") {
    const m = measuredClaudeRun(cmd.slice(2).join(" "), env, t?.price);
    process.stdout.write(m.text.endsWith("\n") ? m.text : m.text + "\n");
    recordDispatch(process.cwd(), { ...base, exit: m.exit, inTokens: m.inTokens, outTokens: m.outTokens, costUsd: m.costUsd });
    console.error(`  [${alias}] ${m.inTokens} in / ${m.outTokens} out tokens, est. $${m.costUsd.toFixed(5)}`);
    process.exit(m.exit);
  }

  // Streaming / arbitrary-command path: inherit stdio, no measurement.
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env });
  recordDispatch(process.cwd(), { ...base, exit: res.status ?? 1 });
  process.exit(res.status ?? 1);
} else if (command === "batch") {
  const tierIdx = args.indexOf("--tier");
  const alias = tierIdx !== -1 ? args[tierIdx + 1] : undefined;
  const fileIdx = args.indexOf("--file");
  const file = fileIdx !== -1 ? args[fileIdx + 1] : undefined;
  if (!alias || !file) usage();
  const resolved = tierEnv(alias);
  if (resolved.missing && resolved.missing.length > 0) {
    console.error(formatTierEnv(resolved));
    process.exit(1);
  }
  const outIdx = args.indexOf("--out");
  const outDir = outIdx !== -1 ? args[outIdx + 1] : undefined;
  // Optional external objective check applied to every task's output (audit M3):
  // a failing output is marked FAIL (recorded exit 1) -- unverified cheap output
  // is at least never SILENTLY green. Without --check, batch stays a founder-eye
  // tool (the documented invariant-1 exemption).
  const checkIdx = args.indexOf("--check");
  let batchCheck: ReturnType<typeof parseCheck> | undefined;
  if (checkIdx !== -1) {
    try {
      batchCheck = parseCheck(args[checkIdx + 1] ?? "");
    } catch (e) {
      console.error((e as Error).message);
      process.exit(2);
    }
  }
  let tasks: string[];
  try {
    tasks = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  const t = KERNEL_TIER_REGISTRY[alias];
  if (outDir) mkdirSync(outDir, { recursive: true });
  console.error(`harness batch: ${tasks.length} task(s) on tier ${alias} (lean${batchCheck ? ", checked" : ""})${outDir ? ` -> ${outDir}/` : ""}`);
  let totIn = 0, totOut = 0, totCost = 0, fails = 0;
  for (let i = 0; i < tasks.length; i++) {
    const m0 = await leanRun(tasks[i], resolved.env ?? {}, t?.price);
    let checkedExit = batchCheck ? (m0.exit === 0 && runCheck(batchCheck, m0.text, process.cwd()) ? 0 : 1) : m0.exit;
    // Output rail: flagged cheap output is a FAILED task (never silently green).
    if (checkedExit === 0 && railsActive()) {
      const rv = await moderationCheck(m0.text);
      if (rv.flagged) checkedExit = 1;
    }
    const m = { ...m0, exit: checkedExit };
    totIn += m.inTokens;
    totOut += m.outTokens;
    totCost += m.costUsd;
    if (m.exit !== 0) fails += 1;
    recordDispatch(process.cwd(), {
      at: new Date().toISOString(),
      tier: alias,
      provider: t?.provider ?? "?",
      model: t?.model ?? "?",
      role: (t?.role ?? "labor") as "judgment" | "labor",
      exit: m.exit,
      inTokens: m.inTokens,
      outTokens: m.outTokens,
      costUsd: m.costUsd,
    });
    if (outDir) writeFileSync(join(outDir, `${i + 1}.txt`), m.text.endsWith("\n") ? m.text : m.text + "\n");
    const preview = outDir ? "" : " -> " + m.text.replace(/\s+/g, " ").trim().slice(0, 80);
    console.error(`  [${i + 1}/${tasks.length}] ${m.inTokens}+${m.outTokens} tok, $${m.costUsd.toFixed(5)}${m.exit ? " FAIL" : ""}${preview}`);
  }
  console.error(`done: ${tasks.length - fails}/${tasks.length} ok, ${totIn} in / ${totOut} out tokens, est. $${totCost.toFixed(4)} total`);
  process.exit(fails ? 1 : 0);
} else if (command === "ask") {
  const tierIdx = args.indexOf("--tier");
  const alias = tierIdx !== -1 ? args[tierIdx + 1] : undefined;
  if (!alias) usage();
  const resolved = tierEnv(alias);
  if (resolved.missing && resolved.missing.length > 0) {
    console.error(formatTierEnv(resolved));
    process.exit(1);
  }
  const promptArgs: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--tier") { i++; continue; }
    if (args[i].startsWith("--")) continue;
    promptArgs.push(args[i]);
  }
  const prompt = promptArgs.join(" ").trim();
  if (!prompt) {
    console.error('usage: harness ask --tier <alias> "<prompt>"');
    process.exit(2);
  }
  const t = KERNEL_TIER_REGISTRY[alias];
  const m = await leanRun(prompt, resolved.env ?? {}, t?.price);
  process.stdout.write(m.text.endsWith("\n") ? m.text : m.text + "\n");
  recordDispatch(process.cwd(), {
    at: new Date().toISOString(),
    tier: alias,
    provider: t?.provider ?? "?",
    model: t?.model ?? "?",
    role: (t?.role ?? "labor") as "judgment" | "labor",
    exit: m.exit,
    inTokens: m.inTokens,
    outTokens: m.outTokens,
    costUsd: m.costUsd,
  });
  // ask is a founder-eye surface: a flagged output warns LOUDLY but the founder
  // sees it and judges (exit unchanged) -- unlike batch/exec, which fail the unit.
  if (railsActive()) {
    const rv = await moderationCheck(m.text);
    if (rv.flagged) console.error(`  RAIL FLAGGED [${rv.categories.join(",")}] -- review before using this output`);
  }
  console.error(`  [${alias} lean] ${m.inTokens} in / ${m.outTokens} out tokens, est. $${m.costUsd.toFixed(5)}`);
  process.exit(m.exit);
} else if (command === "usage") {
  // Observability surface: [dir] scopes to a venture; --fleet aggregates every
  // anchor under cwd (root + apps/*); --tail shows the last n dispatches.
  const base = positional[0] ? positional[0] : process.cwd();
  const tailIdx = args.indexOf("--tail");
  const tailN = tailIdx !== -1 ? Math.max(1, parseInt(args[tailIdx + 1], 10) || 10) : 0;
  let anchors: string[] = [base];
  if (args.includes("--fleet")) {
    const appsDir = join(base, "apps");
    const kids = existsSync(appsDir)
      ? readdirSync(appsDir).map((n) => join(appsDir, n)).filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } })
      : [];
    anchors = [base, ...kids].filter((d) => existsSync(join(d, ".harness", "usage.jsonl")));
    if (anchors.length === 0) anchors = [base];
  }
  const perAnchor = anchors.map((a) => ({ a, records: readUsage(a) }));
  const all = perAnchor.flatMap((x) => x.records);
  console.log(formatUsage(summarizeUsage(all)));
  if (args.includes("--fleet") && perAnchor.length > 1) {
    console.log("  by venture:");
    for (const x of perAnchor) console.log(`    ${String(x.records.length).padStart(4)}  ${x.a.replace(process.cwd() + "/", "") || "."}`);
  }
  if (tailN > 0) {
    const tail = [...all].sort((x, y) => (x.at < y.at ? -1 : 1)).slice(-tailN);
    console.log(`  last ${tail.length}:`);
    for (const d of tail) {
      console.log(`    ${d.at}  ${d.tier.padEnd(10)} ${String(d.model).slice(0, 18).padEnd(18)} ${d.role.padEnd(8)} exit=${d.exit} ${d.inTokens ?? 0}in/${d.outTokens ?? 0}out $${(d.costUsd ?? 0).toFixed(5)}`);
    }
  }
  process.exit(0);
} else if (command === "audit") {
  // The gate's decision trail, human-readable -- what was allowed/denied/held.
  const target = positional[0] ?? process.cwd();
  const manifestPath = resolveManifestPath(target);
  const anchor = manifestPath ? dirname(manifestPath) : target;
  const tailIdx = args.indexOf("--tail");
  const tailN = tailIdx !== -1 ? Math.max(1, parseInt(args[tailIdx + 1], 10) || 20) : 20;
  let lines: string[] = [];
  try {
    lines = readFileSync(join(anchor, ".harness", "audit.jsonl"), "utf8").split("\n").filter((l) => l.trim());
  } catch {
    console.log(`harness audit: no audit trail at ${anchor}/.harness/audit.jsonl`);
    process.exit(0);
  }
  console.log(`harness audit: ${lines.length} decision(s) at ${anchor} -- last ${Math.min(tailN, lines.length)}:`);
  for (const l of lines.slice(-tailN)) {
    try {
      const d = JSON.parse(l);
      console.log(`  ${d.at ?? "?"}  ${String(d.decision).padEnd(5)} ${String(d.tool).padEnd(12)} ${String(d.cmd ?? "").slice(0, 90)}`);
    } catch {
      console.log(`  (unparseable line)`);
    }
  }
  process.exit(0);
} else if (command === "eval") {
  const target = positional[0];
  const suite = positional[1];
  if (!target || !suite) {
    console.error("usage: harness eval <dir|manifest> <suite> [--tier <default>]");
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const tierIdx = args.indexOf("--tier");
  const defaultTier = tierIdx !== -1 ? args[tierIdx + 1] : "bulk";
  const report = await runEval(dirname(manifestPath), suite, defaultTier);
  console.log(formatEvalReport(report));
  process.exit(report.total > 0 && report.passed === report.total ? 0 : 1);
} else if (command === "prove-tier") {
  const target = positional[0];
  const workType = positional[1];
  const tier = positional[2];
  if (!target || !workType || !tier) {
    console.error("usage: harness prove-tier <dir|manifest> <workType> <tier> [--threshold <0-1>]");
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const thIdx = args.indexOf("--threshold");
  const threshold = thIdx !== -1 ? parseFloat(args[thIdx + 1]) : 1.0;
  const rep = await proveTier(dirname(manifestPath), workType, tier, threshold);
  console.log(formatTierProof(rep));
  process.exit(rep.proven ? 0 : 1);
} else if (command === "plan") {
  const target = positional[0];
  const planPath = positional[1];
  if (!target || !planPath) {
    console.error("usage: harness plan <dir|manifest> <plan.jsonl>");
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const cIdx = args.indexOf("--concurrency");
  const concurrency = cIdx !== -1 ? Math.max(1, parseInt(args[cIdx + 1], 10) || 1) : 1;
  const result = await runPlan(manifestPath, planPath, { concurrency });
  console.log(formatPlanResult(result));
  process.exit(result.errors.length > 0 || result.failed > 0 ? 1 : 0);
} else if (command === "drift") {
  const target = positional[0];
  const suite = positional[1];
  const sweepAll = args.includes("--all");
  if (!target || (!suite && !sweepAll)) {
    console.error("usage: harness drift <dir|manifest> <suite> [--window <n>] [--drop <0-1>] [--respond|--recompile]  |  harness drift <dir|manifest> --all [--recompile]");
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const wIdx = args.indexOf("--window");
  const dIdx = args.indexOf("--drop");
  const driftOpts = {
    ...(wIdx !== -1 ? { window: parseInt(args[wIdx + 1], 10) || undefined } : {}),
    ...(dIdx !== -1 ? { drop: parseFloat(args[dIdx + 1]) || undefined } : {}),
  };
  // --all: the nightly sweep -- every suite in the venture's eval history.
  if (sweepAll) {
    const reports = await sweepDrift(manifestPath, driftOpts);
    if (reports.length === 0) console.log("harness drift: no suites in eval history -- nothing to sweep");
    for (const r of reports) {
      console.log(`harness drift: ${r.suite} -- ${r.detail}`);
      try {
        await emitDriftNotifications(manifestPath, { suite: r.suite, revokedGates: r.revoked, ...(r.verdictLevel ? { recompileVerdict: r.verdictLevel } : {}) });
      } catch {
        // emission never blocks exit -- see harness-notify-emit.
      }
    }
    process.exit(0);
  }
  // --recompile = the full L12 cycle: detect -> revoke -> re-materialize + ledger.
  if (args.includes("--recompile")) {
    const cycle = await driftCycle(manifestPath, suite, driftOpts);
    console.log(`harness drift: ${cycle.suite} -- ${cycle.detail}`);
    try {
      await emitDriftNotifications(manifestPath, { suite: cycle.suite, revokedGates: cycle.revoked, ...(cycle.verdictLevel ? { recompileVerdict: cycle.verdictLevel } : {}) });
    } catch {
      // emission never blocks exit -- see harness-notify-emit.
    }
    process.exit(cycle.drifted ? 1 : 0);
  }
  const report = detectDrift(dirname(manifestPath), suite, driftOpts);
  console.log(`harness drift: ${report.suite} -- ${report.detail}`);
  let respondedRevoked: string[] = [];
  if (args.includes("--respond")) {
    respondedRevoked = respondToDrift(dirname(manifestPath), suite, report);
    console.log(respondedRevoked.length ? `  revoked: ${respondedRevoked.join(", ")} (re-earn via harness prove-tier / eval)` : "  nothing revoked");
  }
  try {
    await emitDriftNotifications(manifestPath, {
      suite: report.suite,
      baselineRate: report.baselineRate,
      recentRate: report.recentRate,
      ...(respondedRevoked.length ? { revokedGates: respondedRevoked } : {}),
    });
  } catch {
    // emission never blocks exit -- see harness-notify-emit.
  }
  process.exit(report.drifted ? 1 : 0);
} else if (command === "automate") {
  const target = positional[0];
  if (!target) {
    console.error("usage: harness automate <dir|manifest> [--fire <name>]");
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) {
    for (const e of load.errors) console.error(e);
    process.exit(1);
  }
  const res = resolveProject(KERNEL_DEFAULTS, load.manifest);
  const automations = res.resolved?.automations ?? [];
  const anchor = dirname(manifestPath);
  if (args.includes("--fire-eligible")) {
    const r = fireEligible(anchor, automations);
    for (const f of r.fired) console.log(`  fired   ${f.name} -> exit ${f.exit}`);
    for (const s of r.skipped) console.log(`  skipped ${s.name} (${s.reason})`);
    if (!r.fired.length && !r.skipped.length) console.log("  (no automations declared)");
    process.exit(r.fired.some((f) => f.exit !== 0) ? 1 : 0);
  }
  const fireIdx = args.indexOf("--fire");
  if (fireIdx !== -1) {
    const name = args[fireIdx + 1];
    const a = automations.find((x) => x.name === name);
    if (!a) {
      console.error(`no automation named "${name}"`);
      process.exit(1);
    }
    const result = fireAutomation(anchor, a);
    console.error(result.fired ? `fired ${name} -> exit ${result.exit}` : `NOT fired: ${result.reason}`);
    process.exit(result.fired ? (result.exit ?? 0) : 1);
  }
  console.log(formatAutomations(automations));
  process.exit(0);
} else if (command === "exec") {
  const modelIdx = args.indexOf("--model");
  const model = modelIdx !== -1 ? args[modelIdx + 1] : undefined;
  const tierIdx = args.indexOf("--tier");
  const tier = tierIdx !== -1 ? args[tierIdx + 1] : undefined;
  const toolsIdx = args.indexOf("--tools");
  const allowedTools = toolsIdx !== -1 ? expandToolPresets(args[toolsIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
  const clearIdx = args.indexOf("--clear");
  const clear = clearIdx !== -1 ? args[clearIdx + 1].split(",").map((s) => s.trim()).filter(Boolean) : undefined;
  const timeoutIdx = args.indexOf("--timeout");
  const timeoutMs = timeoutIdx !== -1 ? Math.max(1, parseInt(args[timeoutIdx + 1], 10) || 0) * 1000 : undefined;
  const pos: string[] = [];
  const unknownFlags: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--model" || args[i] === "--tools" || args[i] === "--tier" || args[i] === "--clear" || args[i] === "--timeout") { i++; continue; }
    if (args[i] === "--unsafe-cheap-agentic") continue;
    if (args[i].startsWith("--")) { unknownFlags.push(args[i]); continue; }
    pos.push(args[i]);
  }
  // An unknown flag's value would silently leak into the task text (audit L3) -- refuse.
  if (unknownFlags.length) {
    console.error(`harness exec: unknown flag(s): ${unknownFlags.join(", ")}`);
    process.exit(2);
  }
  const target = pos[0];
  const task = pos.slice(1).join(" ").trim();
  if (!target || !task) {
    console.error('usage: harness exec <dir|manifest> "<task>" [--tier <alias>] [--model <m>] [--tools <A,B,C>] [--clear <op,op>] [--unsafe-cheap-agentic]');
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  const startMs = Date.now();
  const r = await executeTask(manifestPath, task, { ...(tier ? { tier } : {}), ...(model ? { model } : {}), ...(allowedTools ? { allowedTools } : {}), ...(clear ? { clear } : {}), ...(timeoutMs ? { timeoutMs } : {}), ...(args.includes("--unsafe-cheap-agentic") ? { unsafeCheapAgentic: true } : {}) });
  process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  const tools = [...new Set(r.toolCalls)];
  const billing = r.metered ? `$${r.costUsd.toFixed(4)} metered on ${r.tier}` : `notional $${r.costUsd.toFixed(4)}, ${r.tier} on subscription`;
  const heldNote = r.heldOps.length ? `; gated (held): ${r.heldOps.join(",")} -- re-run with --clear <op> to authorize` : "";
  const ctxNote = `; ctx ${r.ctxTokens}tok${r.memTokens ? ` + mem ${r.memTokens}tok` : ""}`;
  const railNote = r.railFlagged ? `; RAIL FLAGGED [${r.railFlagged.join(",")}] -- exit forced non-zero` : "";
  console.error(`  [exec] ${r.turns} turn(s), ${r.inTokens} in / ${r.outTokens} out, ${billing}; tools: ${tools.join(",") || "none"}${ctxNote}${heldNote}${railNote}`);
  try {
    await emitExecNotifications(manifestPath, startMs, {
      exit: r.exit,
      heldOps: r.heldOps,
      ...(r.railFlagged ? { railFlagged: r.railFlagged } : {}),
      tier: r.tier,
      costUsd: r.costUsd,
      ctxTokens: r.ctxTokens,
      memTokens: r.memTokens,
      toolCalls: r.toolCalls,
      task,
    });
  } catch {
    // emission never blocks exit -- see harness-notify-emit.
  }
  process.exit(r.exit);
} else if (command === "route") {
  const wtIdx = args.indexOf("--work-type");
  const workType = wtIdx !== -1 ? args[wtIdx + 1] : undefined;
  const tierIdx = args.indexOf("--tier");
  const tier = tierIdx !== -1 ? args[tierIdx + 1] : undefined;
  const checkIdx = args.indexOf("--check");
  const checkSpec = checkIdx !== -1 ? args[checkIdx + 1] : undefined;
  const roleIdx = args.indexOf("--role");
  const role = roleIdx !== -1 ? args[roleIdx + 1] : undefined;
  const refuteIdx = args.indexOf("--refute");
  const refuteN = refuteIdx !== -1 ? parseInt(args[refuteIdx + 1], 10) || 3 : undefined;
  const pos: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--work-type" || args[i] === "--tier" || args[i] === "--check" || args[i] === "--role" || args[i] === "--refute") { i++; continue; }
    if (args[i].startsWith("--")) continue;
    pos.push(args[i]);
  }
  const target = pos[0];
  const prompt = pos.slice(1).join(" ").trim();
  if (!target || !workType || !checkSpec || !prompt) {
    console.error('usage: harness route <dir|manifest> --work-type <X> --check <equals:..|contains:..|regex:/../|command:..> [--tier <cheap>] "<prompt>"');
    process.exit(2);
  }
  const manifestPath = resolveManifestPath(target);
  if (!manifestPath) {
    console.error(`no harness/v1 manifest found at ${target}`);
    process.exit(1);
  }
  let routeCheck;
  try {
    routeCheck = parseCheck(checkSpec);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const r = await routeVerified(manifestPath, { prompt, workType, check: routeCheck, ...(tier ? { tier } : {}), ...(role ? { role } : {}), ...(refuteN ? { refute: { n: refuteN } } : {}) });
  process.stdout.write(r.text.endsWith("\n") ? r.text : r.text + "\n");
  console.error(formatRouteResult(r));
  try {
    await emitRouteNotifications(manifestPath, { accepted: r.exit === 0, tier: r.acceptedTier, costUsd: r.costUsd, workType });
  } catch {
    // emission never blocks exit -- see harness-notify-emit.
  }
  process.exit(r.exit);
} else if (command === "post") {
  const file = positional[0];
  if (!file) {
    console.error('usage: harness post <file> [--channel <C...|#name|worksite|ops|telemetry>] [--say "caption"] [--dir <venture>]');
    process.exit(2);
  }
  const channelIdx = args.indexOf("--channel");
  const channelArg = channelIdx !== -1 ? args[channelIdx + 1] : "worksite";
  const sayIdx = args.indexOf("--say");
  const caption = sayIdx !== -1 ? args[sayIdx + 1] : undefined;
  const dirIdx = args.indexOf("--dir");
  const dir = dirIdx !== -1 ? args[dirIdx + 1] : ".";

  let channel: string | null = null;
  if (channelArg === "worksite" || channelArg === "ops" || channelArg === "telemetry") {
    const manifestPath = resolveManifestPath(dir);
    if (!manifestPath) {
      console.error(`no harness/v1 manifest found at ${dir}`);
      process.exit(1);
    }
    const load = loadHarnessManifest(manifestPath);
    channel = load.manifest?.notify?.slack?.[channelArg] ?? null;
    if (!channel) {
      console.error(`harness post: no notify.slack.${channelArg} channel configured at ${manifestPath}`);
      process.exit(1);
    }
  } else if (channelArg.startsWith("C")) {
    channel = channelArg;
  } else {
    channel = await resolveChannelId(channelArg);
  }
  if (!channel) {
    console.error(`harness post: could not resolve channel "${channelArg}"`);
    process.exit(1);
  }
  const result = await slackUploadFile({ channel, path: file, comment: caption });
  console.log(JSON.stringify(result));
  process.exit(result.ok || result.skipped ? 0 : 1);
} else if (command === "slack" && positional[0] === "listen") {
  // SAFETY 7 (docs/harness/orders/order-J-socket-listener.md): fail-closed if
  // either credential is unset -- with no operator id or app token, nothing
  // could ever be authorized, so refuse to start rather than listen inert.
  if (!process.env.SLACK_APP_TOKEN || !process.env.SLACK_OPERATOR_ID) {
    console.error(
      "harness slack listen: SLACK_APP_TOKEN and SLACK_OPERATOR_ID must both be set -- refusing to start (fail-closed)",
    );
    process.exit(1);
  }
  const dirArg = positional[1] ?? process.cwd();
  const manifestPath = resolveManifestPath(dirArg);
  const anchor = manifestPath ? dirname(manifestPath) : dirArg;
  await runListener({ anchor });
} else if (command === "tidy") {
  // Scope: the single repo at dir (default cwd) -- never reaches into sibling
  // repos. Dry-run by default; --apply attempts only git branch -d (never -D,
  // git's own refusal of unmerged branches is the safety floor) + git worktree
  // prune (dead admin entries only, never a live worktree dir).
  const dir = positional[0] ?? process.cwd();
  const result = tidy(dir, { apply: flags.has("--apply"), includeGone: flags.has("--include-gone") });
  console.log(formatTidyResult(result));
  process.exit(0);
} else if (command === "notify-commit") {
  // A `.husky/post-commit` hook helper (Order N), fired detached/backgrounded --
  // fail-soft always: no manifest, no notify config, or a Slack hiccup are all
  // silent no-ops (exit 0), never a reason to make `git commit` look broken.
  const dir = positional[0] ?? process.cwd();
  const shaIdx = args.indexOf("--sha");
  const sha = shaIdx !== -1 ? args[shaIdx + 1] : undefined;
  const manifestPath = resolveManifestPath(dir);
  if (manifestPath) {
    try {
      await emitCommitNotification(manifestPath, { ...(sha ? { sha } : {}), repoRoot: dirname(manifestPath) });
    } catch {
      // fail-soft -- see module doc.
    }
  }
  process.exit(0);
} else {
  usage();
}
