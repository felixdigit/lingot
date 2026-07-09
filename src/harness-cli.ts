import { existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
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
import { tierEnv, formatTierEnv } from "./harness-dispatch";
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
      "  harness run --tier <alias> [-- <cmd...>]",
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
  const sep = args.indexOf("--");
  const cmd = sep !== -1 ? args.slice(sep + 1) : [];
  if (cmd.length === 0) {
    console.log(formatTierEnv(resolved));
    console.log("  (dry run -- pass `-- <command>` to launch it on this tier)");
    process.exit(0);
  }
  const res = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...resolved.env } });
  const t = KERNEL_TIER_REGISTRY[alias!];
  recordDispatch(process.cwd(), {
    at: new Date().toISOString(),
    tier: alias!,
    provider: t?.provider ?? "?",
    model: t?.model ?? "?",
    role: t?.role ?? "labor",
    exit: res.status ?? 1,
  });
  process.exit(res.status ?? 1);
} else if (command === "usage") {
  console.log(formatUsage(summarizeUsage(readUsage(process.cwd()))));
  process.exit(0);
} else {
  usage();
}
