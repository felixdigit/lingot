import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sweep, formatSweepReport, canonicalPath, type Registry } from "./registry";
import { renderMap } from "./map";
import { loadVentureManifest } from "./venture";
import {
  doctorAll,
  doctorOne,
  formatDoctorReport,
  renderBaselineMarkdown,
  findingKeys,
  stampReport,
  verifyReport,
  type DoctorReport,
} from "./doctor";

/**
 * Lingot CLI (P1 + P3 surfaces). Lingot is called ON a folder, never invoked
 * as the folder's self-check -- the checked thing must not own its own gate.
 *
 *   pnpm lingot registry --sweep [root] [--check]   census -> registry.json (--check: no write; exit 1 on red)
 *   pnpm lingot map [studio-root]                   registry.json (+ doctor.json if present) -> map.html
 *   pnpm lingot doctor <path> [--json]              conformance for one anchor
 *   pnpm lingot doctor --all [root] [--json]        every registry anchor + the studio plane
 *          --write     also write registry/doctor.json + doctor-baseline.md (the committed baseline)
 *          --ratchet   compare against committed doctor.json; exit 1 only on NEW reds (pre-commit mode)
 *
 * `lingot compile` lands at P4.
 */

function usage(): never {
  console.log(
    "usage: lingot registry --sweep [root] [--check] | lingot map [studio-root] | lingot doctor <path>|--all [root] [--json|--write|--ratchet]",
  );
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
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.slice(1).filter((a) => !a.startsWith("--"));

if (command === "registry") {
  if (!flags.has("--sweep")) usage();
  const registry = sweep(positional[0] ?? "~/work", { write: !flags.has("--check") });
  console.log(formatSweepReport(registry));
  process.exit(registry.verdict === "green" ? 0 : 1);
} else if (command === "map") {
  const studioRoot = canonicalPath(positional[0] ?? process.cwd());
  const registryDir = locateRegistryDir(studioRoot);
  const registryPath = join(registryDir, "registry.json");
  if (!existsSync(registryPath)) {
    console.error(`no registry at ${registryPath} -- run: pnpm lingot registry --sweep`);
    process.exit(1);
  }
  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Registry;
  const doctorPath = join(registryDir, "doctor.json");
  const doctor = existsSync(doctorPath) ? (JSON.parse(readFileSync(doctorPath, "utf8")) as DoctorReport) : undefined;
  const outPath = join(registryDir, "map.html");
  writeFileSync(outPath, renderMap(registry, doctor));
  console.log(
    `org map rendered: ${outPath} (${registry.ventures.length} ventures, ${registry.strays.length} strays, ` +
      `sweep ${registry.verdict}${doctor ? `, doctor ${doctor.verdict} @ ${doctor.generated.slice(0, 10)}` : ", doctor pending"})`,
  );
} else if (command === "doctor") {
  if (flags.has("--all")) {
    const root = positional[0] ?? "~/work";
    const write = flags.has("--write");
    const { report, registry } = doctorAll(root, { write });
    const studio = registry.ventures.find((v) => v.kind === "studio");
    const registryDir = studio?.manifest.studio ? join(studio.anchor, studio.manifest.studio.registry) : undefined;
    if (flags.has("--ratchet")) {
      if (!registryDir || !existsSync(join(registryDir, "doctor.json"))) {
        console.error("ratchet: no committed doctor.json baseline -- run: pnpm lingot doctor --all --write");
        process.exit(1);
      }
      const baseline = JSON.parse(readFileSync(join(registryDir, "doctor.json"), "utf8")) as DoctorReport;
      if (!verifyReport(baseline)) {
        console.error(
          "ratchet: the committed doctor.json fails provenance verification (hand-edited or pre-provenance) -- " +
            "a baseline is only writable by running the checks: pnpm lingot doctor --all --write",
        );
        process.exit(1);
      }
      const baseKeys = findingKeys(baseline);
      const newReds = [...findingKeys(report)].filter((k) => !baseKeys.has(k));
      if (newReds.length > 0) {
        console.error(`doctor ratchet: ${newReds.length} NEW red(s) vs the committed baseline:`);
        for (const k of newReds) console.error(`  ✗ ${k.replaceAll("|", " / ")}`);
        console.error("fix the regression, or re-baseline deliberately with: pnpm lingot doctor --all --write");
        process.exit(1);
      }
      const cured = [...baseKeys].filter((k) => !findingKeys(report).has(k)).length;
      console.log(`doctor ratchet: no new reds (baseline ${baseKeys.size} red, live ${findingKeys(report).size}${cured > 0 ? `, ${cured} cured -- consider re-baselining` : ""})`);
      process.exit(0);
    }
    if (flags.has("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDoctorReport(report));
    }
    if (write && registryDir) {
      writeFileSync(join(registryDir, "doctor.json"), JSON.stringify(stampReport(report), null, 2) + "\n");
      writeFileSync(join(registryDir, "doctor-baseline.md"), renderBaselineMarkdown(report));
      console.log(`\nbaseline written (provenance-stamped): ${join(registryDir, "doctor.json")} + doctor-baseline.md`);
    }
    process.exit(report.verdict === "green" ? 0 : 1);
  }
  const anchor = canonicalPath(positional[0] ?? process.cwd());
  const manifestPath = join(anchor, "lingot.json");
  const { manifest, errors } = loadVentureManifest(manifestPath);
  if (!manifest) {
    for (const e of errors) console.error(e);
    process.exit(1);
  }
  const report = doctorOne(anchor, manifest.identity.name, manifest.identity.kind, manifest);
  const hasRed = report.findings.some((f) => f.level === "red");
  if (flags.has("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`lingot doctor ${anchor}`);
    for (const c of report.concerns) console.log(`  ${c.concern}: ${c.verdict.toUpperCase()}${c.yellows ? ` (${c.yellows} yellow)` : ""}`);
    for (const f of report.findings) console.log(`  ${f.level === "red" ? "✗" : f.level === "yellow" ? "△" : "·"} [${f.concern}/${f.check}] ${f.message}`);
  }
  process.exit(hasRed ? 1 : 0);
} else {
  usage();
}
