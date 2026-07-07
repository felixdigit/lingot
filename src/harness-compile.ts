import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dbProject, type VentureManifest } from "./venture";

/**
 * `lingot compile` -- the compiled half of the harness, SHADOW mode (P4, HX-009).
 * From a venture's manifest (kernel version + modules + overlay paths), emit the
 * kernel-slice harness into a shadow directory -- NEVER .claude/ directly.
 * Kernel source: engine/lingot/kernel/* (extracted from Ortova's organic harness
 * per the P2 extraction map, coupling seams parameterized to manifest fields).
 * Nothing compiled goes live without the parity gate + Felix's P4-adopt word.
 */

const KERNEL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel");

export interface KernelMeta {
  readonly kernel: string;
  readonly templates: Record<string, string>;
}

export function loadKernel(): KernelMeta {
  return JSON.parse(readFileSync(join(KERNEL_DIR, "kernel.json"), "utf8")) as KernelMeta;
}

/**
 * Minimal template renderer: {{key}} substitution (dotted paths into the
 * context), {{#key}}...{{/key}} kept when truthy, {{^key}}...{{/key}} kept when
 * falsy. Unresolved {{key}} renders as an explicit <UNRESOLVED:key> marker so
 * the shadow diff shows the kernel's gaps instead of hiding them.
 */
export function renderTemplate(template: string, ctx: Record<string, unknown>): string {
  const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (typeof o === "object" && o !== null ? (o as Record<string, unknown>)[k] : undefined), ctx);
  let out = template.replace(/\{\{#([\w.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, body: string) => (get(key) ? body : ""));
  out = out.replace(/\{\{\^([\w.-]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_, key: string, body: string) => (get(key) ? "" : body));
  out = out.replace(/\{\{([\w.-]+)\}\}/g, (_, key: string) => {
    const v = get(key);
    return v === undefined || v === null ? `<UNRESOLVED:${key}>` : String(v);
  });
  return out;
}

function templateContext(manifest: VentureManifest): Record<string, unknown> {
  const founderRaw = manifest.identity.owners[0] ?? "the founder";
  const gateWall = manifest.harness.modules["gate-wall"] as { gated?: string[]; enforcement?: string } | undefined;
  return {
    name: manifest.identity.name,
    title: manifest.identity.name.charAt(0).toUpperCase() + manifest.identity.name.slice(1),
    founder: founderRaw.charAt(0).toUpperCase() + founderRaw.slice(1),
    aliases: manifest.identity.aliases ?? {},
    overlay: manifest.harness.overlay ?? {},
    state: manifest.state,
    modules: manifest.harness.modules,
    db: manifest.db ?? undefined,
    dbProject: dbProject(manifest.db ?? undefined),
    // The gate-wall's gated list rendered as a readable inline phrase (the raw
    // array String()s to a bare comma-join; this keeps the compiled prose clean).
    gateWallList: gateWall?.gated ? gateWall.gated.join(", ") : "",
  };
}

/**
 * A venture-authored front charter (`<anchor>/docs/fronts/zone-N-<slug>.md`),
 * parsed into its named `## <slot>` sections. The compiler inlines these into
 * the pack template's `{{charter.<slot>}}` OVERLAY slots -- the P4 filling
 * mechanism, so a compiled pack carries the venture's real routing content
 * instead of a hollow skeleton. Missing charter or slot -> the renderer's
 * explicit `<UNRESOLVED:charter.<slot>>` marker shows the gap in the diff.
 */
function loadCharter(anchor: string, zone: number, slug: string): Record<string, string> {
  const path = join(anchor, "docs", "fronts", `zone-${zone}-${slug}.md`);
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  const out: Record<string, string> = {};
  const headers = [...text.matchAll(/^##\s+(.+?)\s*$/gm)];
  for (let k = 0; k < headers.length; k++) {
    const name = headers[k][1].trim();
    const start = (headers[k].index ?? 0) + headers[k][0].length;
    const end = k + 1 < headers.length ? (headers[k + 1].index ?? text.length) : text.length;
    out[name] = text.slice(start, end).trim();
  }
  return out;
}

/** Front slugs from charter filenames (`docs/fronts/zone-N-<slug>.md`), by zone number. */
function charterSlugs(anchor: string): Map<number, string> {
  const dir = join(anchor, "docs", "fronts");
  const map = new Map<number, string>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^zone-(\d+)-(.+)\.md$/);
    if (m) map.set(Number(m[1]), m[2]);
  }
  return map;
}

/** Organic zone-pack filenames at the anchor, by zone number, for slug + diff alignment. */
function organicZonePacks(anchor: string): Map<number, string> {
  const dir = join(anchor, ".claude", "agents");
  const map = new Map<number, string>();
  if (!existsSync(dir)) return map;
  for (const f of readdirSync(dir)) {
    const m = f.match(/^zone-(\d+)-(.+)\.md$/);
    if (m) map.set(Number(m[1]), f);
  }
  return map;
}

export interface CompileResult {
  readonly outDir: string;
  readonly files: readonly string[];
  readonly kernel: string;
}

export function compileHarness(manifest: VentureManifest, anchor: string, outDir: string): CompileResult {
  const kernel = loadKernel();
  const ctx = templateContext(manifest);
  const files: string[] = [];
  const emit = (rel: string, content: string) => {
    const path = join(outDir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    files.push(rel);
  };
  emit("CLAUDE.base.md", renderTemplate(readFileSync(join(KERNEL_DIR, kernel.templates.contract), "utf8"), ctx));
  const zoneSet = manifest.harness.modules["zone-set"] as { fronts?: number } | undefined;
  if (zoneSet?.fronts) {
    const packTemplate = readFileSync(join(KERNEL_DIR, kernel.templates.pack), "utf8");
    const charters = charterSlugs(anchor);
    const organic = organicZonePacks(anchor);
    for (let i = 1; i <= zoneSet.fronts; i++) {
      // Slug source, in order: the venture charter filename, then an already-organic
      // pack filename, then the generic front-N fallback.
      const organicName = organic.get(i);
      const slug = charters.get(i) ?? (organicName ? organicName.replace(/^zone-\d+-|\.md$/g, "") : `front-${i}`);
      const charter = loadCharter(anchor, i, slug);
      emit(`packs/zone-${i}-${slug}.md`, renderTemplate(packTemplate, { ...ctx, zone: i, zoneSlug: slug, charter }));
    }
  }
  emit("skills/boot.md", renderTemplate(readFileSync(join(KERNEL_DIR, kernel.templates.boot), "utf8"), ctx));
  emit(
    "compiled.json",
    JSON.stringify(
      { kernel: kernel.kernel, venture: manifest.identity.name, files: files.filter((f) => f !== "compiled.json"), shadow: true },
      null,
      2,
    ) + "\n",
  );
  return { outDir, files, kernel: kernel.kernel };
}

// ------------------------------------------------------------------- diff

/** Longest-common-subsequence line count (files are a few hundred lines; O(n*m) is fine). */
function lcsLines(a: string[], b: string[]): number {
  const dp: number[] = new Array((a.length + 1) * (b.length + 1)).fill(0);
  const w = b.length + 1;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * w + j] = a[i - 1] === b[j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  return dp[a.length * w + b.length];
}

export interface FileDrift {
  readonly compiled: string;
  readonly organic: string | null;
  readonly compiledLines: number;
  readonly organicLines: number;
  readonly commonLines: number;
  /** Lines only in one side (added + removed vs the organic). */
  readonly driftLines: number;
  /** Word-level LCS coverage of the organic text (0-100). Lines punish reflow; words do not. */
  readonly wordCoverage: number;
}

export interface DriftReport {
  readonly files: readonly FileDrift[];
  readonly totals: { driftLines: number; organicLines: number; commonLines: number };
}

const nonEmpty = (text: string): string[] => text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9'-]+/).filter((w) => w.length > 0).slice(0, 4000);

/** Word-level LCS coverage of the organic text: same content reflowed across lines still counts. */
function wordCoverage(compiledText: string, organicText: string): number {
  const o = words(organicText);
  if (o.length === 0) return 0;
  return Math.round((100 * lcsLines(words(compiledText), o)) / o.length);
}

/** Pair each compiled file with its organic counterpart at the anchor. */
function organicCounterpart(anchor: string, compiledRel: string): string | null {
  if (compiledRel === "CLAUDE.base.md") {
    const p = join(anchor, "CLAUDE.md");
    return existsSync(p) ? p : null;
  }
  const zone = compiledRel.match(/^packs\/(zone-\d+-.+\.md)$/);
  if (zone) {
    const p = join(anchor, ".claude", "agents", zone[1]);
    return existsSync(p) ? p : null;
  }
  if (compiledRel === "skills/boot.md") {
    const p = join(anchor, ".claude", "skills", "boot", "SKILL.md");
    return existsSync(p) ? p : null;
  }
  return null;
}

export function diffHarness(anchor: string, outDir: string): DriftReport {
  const compiledMeta = JSON.parse(readFileSync(join(outDir, "compiled.json"), "utf8")) as { files: string[] };
  const files: FileDrift[] = [];
  for (const rel of compiledMeta.files) {
    const compiledLines = nonEmpty(readFileSync(join(outDir, rel), "utf8"));
    const organicPath = organicCounterpart(anchor, rel);
    if (!organicPath) {
      files.push({ compiled: rel, organic: null, compiledLines: compiledLines.length, organicLines: 0, commonLines: 0, driftLines: compiledLines.length, wordCoverage: 0 });
      continue;
    }
    const organicText = readFileSync(organicPath, "utf8");
    const compiledText = readFileSync(join(outDir, rel), "utf8");
    const organicLines = nonEmpty(organicText);
    const common = lcsLines(compiledLines, organicLines);
    files.push({
      compiled: rel,
      organic: organicPath,
      compiledLines: compiledLines.length,
      organicLines: organicLines.length,
      commonLines: common,
      driftLines: compiledLines.length - common + (organicLines.length - common),
      wordCoverage: wordCoverage(compiledText, organicText),
    });
  }
  const totals = files.reduce(
    (t, f) => ({ driftLines: t.driftLines + f.driftLines, organicLines: t.organicLines + f.organicLines, commonLines: t.commonLines + f.commonLines }),
    { driftLines: 0, organicLines: 0, commonLines: 0 },
  );
  return { files, totals };
}

// ------------------------------------------------------------------ replay

export interface RubricPoint {
  readonly point: string;
  readonly organic: boolean;
  readonly compiled: boolean;
}

export interface ReplayResult {
  readonly pack: string;
  readonly points: readonly RubricPoint[];
  /** Parity: the compiled pack passes every rubric point the organic pack passes. */
  readonly parity: boolean;
}

const PACK_SECTIONS = [
  /^##\s+Who you are/im,
  /^##\s+Invariants/im,
  /^##\s+Read these fresh/im,
  /^##\s+How you work/im,
  /^##\s+Sub-context routing/im,
  /^##\s+Tools\s*(&|and)\s*gates/im,
  /^##\s+What you're handed/im,
  /^##\s+Safety rails/im,
  /^##\s+Done\s*=\s*reviewable/im,
];

/** The mechanical slice of the zone-agent-spec §7 rubric (structure, not judgment). */
function scorePack(text: string): Record<string, boolean> {
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const fmText = fm?.[1] ?? "";
  const toolsLine = fmText.match(/^tools:\s*(.+)$/m)?.[1]?.trim() ?? "";
  return {
    "frontmatter (name + description + tools)": /^name:/m.test(fmText) && /^description:/m.test(fmText) && /^tools:/m.test(fmText),
    "least-privilege tools (never *)": toolsLine.length > 0 && toolsLine !== "*",
    "eight-section anatomy present": PACK_SECTIONS.every((rx) => rx.test(text)),
    "global invariants by reference": /by reference|global \(from/i.test(text),
    "two-shape return (artifact | decision card)": /decision card/i.test(text),
    "gate posture (founder-gated ops named)": /\b(gated|gate)\b/i.test(text) && /felix|founder/i.test(text),
    "done = reviewable, parks at review": /review/i.test(text) && /\b(tile|commit)\b/i.test(text),
  };
}

export function replayPack(organicPath: string, compiledPath: string): ReplayResult {
  const organic = scorePack(readFileSync(organicPath, "utf8"));
  const compiled = scorePack(readFileSync(compiledPath, "utf8"));
  const points: RubricPoint[] = Object.keys(organic).map((point) => ({ point, organic: organic[point], compiled: compiled[point] }));
  return {
    pack: basename(compiledPath),
    points,
    parity: points.every((p) => !p.organic || p.compiled),
  };
}

// --------------------------------------------------------------- formatting

export function formatDrift(report: DriftReport): string {
  const lines: string[] = [];
  lines.push("shadow diff (compiled vs organic, non-empty lines, LCS-aligned)");
  for (const f of report.files) {
    if (!f.organic) {
      lines.push(`  ${f.compiled.padEnd(34)} NO ORGANIC COUNTERPART (${f.compiledLines} compiled lines)`);
      continue;
    }
    const coverage = f.organicLines > 0 ? Math.round((100 * f.commonLines) / f.organicLines) : 0;
    lines.push(`  ${f.compiled.padEnd(34)} organic ${String(f.organicLines).padStart(4)} · compiled ${String(f.compiledLines).padStart(4)} · drift ${String(f.driftLines).padStart(4)} · line-cov ${String(coverage).padStart(3)}% · word-cov ${String(f.wordCoverage).padStart(3)}%`);
  }
  const cov = report.totals.organicLines > 0 ? Math.round((100 * report.totals.commonLines) / report.totals.organicLines) : 0;
  lines.push(`  TOTAL drift ${report.totals.driftLines} lines · organic-coverage ${cov}%`);
  return lines.join("\n");
}

export function formatReplay(result: ReplayResult): string {
  const lines: string[] = [`pack replay parity -- ${result.pack}`];
  for (const p of result.points) {
    lines.push(`  ${p.organic ? "org ✓" : "org —"} | ${p.compiled ? "cmp ✓" : "cmp ✗"}  ${p.point}`);
  }
  lines.push(`  PARITY: ${result.parity ? "PASS (compiled passes every point the organic passes)" : "FAIL"}`);
  return lines.join("\n");
}
