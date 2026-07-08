import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { adopt } from "./harness-adopt";
import { formatVerdict } from "./harness-verdict";

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
  console.log("usage: harness boot <dir|manifest> [--dry] | harness adopt <dir|manifest>");
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
} else {
  usage();
}
