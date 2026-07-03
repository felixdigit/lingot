import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { sweep, formatSweepReport, expandTilde, type Registry } from "./registry";
import { renderMap } from "./map";
import { loadVentureManifest } from "./venture";

/**
 * Lingot CLI, P1 surface (HX-005). Lingot is called ON a folder, never invoked
 * as the folder's self-check -- the checked thing must not own its own gate.
 *
 *   pnpm lingot registry --sweep [root]   census + strays + triage join -> registry.json (exit 1 on red)
 *   pnpm lingot map [studio-root]         registry.json -> map.html
 *
 * `lingot doctor` and `lingot compile` land at P3/P4.
 */

function usage(): never {
  console.log("usage: lingot registry --sweep [root=~/work] | lingot map [studio-root=cwd]");
  process.exit(2);
}

function locateRegistryDir(studioRoot: string): string {
  const manifestPath = join(studioRoot, "lingot.json");
  if (!existsSync(manifestPath)) {
    console.error(`no studio manifest at ${manifestPath}`);
    process.exit(1);
  }
  const { manifest, errors } = loadVentureManifest(manifestPath);
  if (!manifest?.studio) {
    for (const e of errors) console.error(e);
    console.error(`${manifestPath}: not a studio-kind manifest with a studio.registry block`);
    process.exit(1);
  }
  return join(studioRoot, manifest.studio.registry);
}

const args = process.argv.slice(2);
const command = args[0];

if (command === "registry") {
  if (!args.includes("--sweep")) usage();
  const positional = args.filter((a) => a !== "registry" && a !== "--sweep");
  const root = positional[0] ?? "~/work";
  const registry = sweep(root);
  console.log(formatSweepReport(registry));
  process.exit(registry.verdict === "green" ? 0 : 1);
} else if (command === "map") {
  const studioRoot = resolve(expandTilde(args[1] ?? process.cwd()));
  const registryDir = locateRegistryDir(studioRoot);
  const registryPath = join(registryDir, "registry.json");
  if (!existsSync(registryPath)) {
    console.error(`no registry at ${registryPath} -- run: pnpm lingot registry --sweep`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const outPath = join(registryDir, "map.html");
  writeFileSync(outPath, renderMap(registry));
  console.log(`org map rendered: ${outPath} (${registry.ventures.length} ventures, ${registry.strays.length} strays, verdict ${registry.verdict})`);
} else {
  usage();
}
