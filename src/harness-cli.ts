import { existsSync, statSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
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
import { tierEnv, formatTierEnv, measuredClaudeRun } from "./harness-dispatch";
import { formatVerdict } from "./harness-verdict";
import { doctorProject, formatHarnessDoctorReport } from "./harness-doctor";
import { resolveLock, formatLock } from "./harness-lock";
import { recordGatePass } from "./harness-gates";
import { recordDispatch, readUsage, summarizeUsage, formatUsage } from "./harness-usage";
import { KERNEL_TIER_REGISTRY } from "./harness-kernel";

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

function usage(): never {
  console.log(
    [
      "usage:",
      "  harness boot <dir|manifest> [--dry]",
      "  harness adopt <dir|manifest>",
      "  harness doctor <dir|manifest>",
      "  harness lock <dir|manifest>",
      "  harness gate-pass <dir|manifest> <suite> [--by <who>]",
      "  harness run --tier <alias> [\"<prompt>\"] [--dry] [-- <cmd...>]",
      "  harness batch --tier <alias> --file <tasks.txt> [--out <dir>]",
      "  harness usage",
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
  const env = { ...process.env, ...resolved.env };
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
  let tasks: string[];
  try {
    tasks = readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  } catch (e) {
    console.error(`cannot read ${file}: ${(e as Error).message}`);
    process.exit(1);
  }
  const t = KERNEL_TIER_REGISTRY[alias];
  const env = { ...process.env, ...resolved.env };
  if (outDir) mkdirSync(outDir, { recursive: true });
  console.error(`harness batch: ${tasks.length} task(s) on tier ${alias}${outDir ? ` -> ${outDir}/` : ""}`);
  let totIn = 0, totOut = 0, totCost = 0, fails = 0;
  for (let i = 0; i < tasks.length; i++) {
    const m = measuredClaudeRun(tasks[i], env, t?.price);
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
} else if (command === "usage") {
  console.log(formatUsage(summarizeUsage(readUsage(process.cwd()))));
  process.exit(0);
} else {
  usage();
}
