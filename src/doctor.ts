import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { sweep, type Registry, type RegistryVenture } from "./registry";
import { dbProject, type VentureManifest } from "./venture";

/**
 * `lingot doctor` -- mechanical conformance (HX-006, P3).
 * The five concerns as capability checks + the studio plane (registry, DB
 * census, repo census, exchange). Every check reads real disk/config; the
 * doctor never contains venture knowledge -- the manifest declares WHAT the
 * venture is, the doctor verdicts WHETHER it is that. Lingot is called ON a
 * folder, never as the folder's self-check.
 */

export const CONCERNS = ["AUTHORITY", "TRUTH", "LABOR", "QUALITY", "LEARNING"] as const;
export const STUDIO_CONCERNS = ["REGISTRY", "DB-CENSUS", "REPO-CENSUS", "EXCHANGE"] as const;

export interface DoctorFinding {
  readonly venture: string;
  readonly concern: string;
  readonly check: string;
  readonly level: "red" | "yellow" | "info";
  readonly message: string;
}

export interface ConcernVerdict {
  readonly concern: string;
  readonly verdict: "green" | "red";
  readonly reds: number;
  readonly yellows: number;
}

export interface VentureDoctorReport {
  readonly name: string;
  readonly kind: string;
  readonly anchor: string;
  readonly placement: string;
  readonly concerns: readonly ConcernVerdict[];
  readonly findings: readonly DoctorFinding[];
}

export interface DoctorReport {
  readonly generated: string;
  readonly tool: string;
  readonly ventures: readonly VentureDoctorReport[];
  readonly studioFindings: readonly DoctorFinding[];
  readonly totals: { reds: number; yellows: number; infos: number };
  readonly verdict: "green" | "red";
  /** Stamped by --write only; the ratchet refuses a baseline whose digest does not verify. */
  readonly provenance?: { readonly tool: string; readonly digest: string };
}

/**
 * Digest over the report content (provenance excluded). A baseline is only
 * writable by running the checks (--write computes findings itself), so a
 * hand-edited doctor.json fails verification instead of laundering a new red.
 */
export function reportDigest(report: DoctorReport): string {
  const { provenance: _provenance, ...content } = report;
  return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

/** Attach provenance for persistence (--write). */
export function stampReport(report: DoctorReport): DoctorReport {
  return { ...report, provenance: { tool: report.tool, digest: reportDigest(report) } };
}

/** Verify a loaded baseline's provenance. */
export function verifyReport(report: DoctorReport): boolean {
  return report.provenance !== undefined && report.provenance.digest === reportDigest(report);
}

// ---------------------------------------------------------------- utilities

function git(anchor: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", ["-C", anchor, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function isGitRepoRoot(anchor: string): boolean {
  return existsSync(join(anchor, ".git"));
}

function pkgScripts(anchor: string): Record<string, string> {
  const path = join(anchor, "package.json");
  if (!existsSync(path)) return {};
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return {};
  }
}

function safeStat(path: string): { isFile(): boolean; isDirectory(): boolean } | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined; // dangling symlink or permission hole -- treat as absent
  }
}

function listFiles(dir: string, suffix = ""): string[] {
  if (!safeStat(dir)?.isDirectory()) return [];
  return readdirSync(dir).filter((f) => f.endsWith(suffix) && safeStat(join(dir, f))?.isFile());
}

function readIf(path: string): string {
  return safeStat(path)?.isFile() ? readFileSync(path, "utf8") : "";
}

/** All hook/workflow text that could wire a check: anchor's own + the studio's when nested. */
function wiringText(anchor: string, studioAnchor?: string): string {
  const parts: string[] = [];
  for (const root of [anchor, ...(studioAnchor && studioAnchor !== anchor ? [studioAnchor] : [])]) {
    for (const wf of listFiles(join(root, ".github", "workflows"))) parts.push(readIf(join(root, ".github", "workflows", wf)));
    for (const hook of listFiles(join(root, ".husky"))) parts.push(readIf(join(root, ".husky", hook)));
    const preCommit = join(root, ".git", "hooks", "pre-commit");
    if (existsSync(preCommit)) parts.push(readIf(preCommit));
  }
  return parts.join("\n");
}

/**
 * Resolve a declared-surface string against the anchor: any path-like token
 * that exists, or a `pnpm <script>` whose script is defined, counts.
 * Declarations are prose-ish ("operations/ + HANDOFF.md"), so tokens are
 * extracted, not the string taken literally.
 */
function declarationResolves(anchor: string, value: string): boolean {
  const scripts = pkgScripts(anchor);
  const pnpmRefs = [...value.matchAll(/pnpm\s+(?:run\s+)?([a-z0-9:_-]+)/gi)].map((m) => m[1]);
  if (pnpmRefs.some((s) => s in scripts)) return true;
  const tokens = value
    .split(/[\s+]+/)
    .map((t) => t.replace(/^[([]+|[)\],;]+$/g, ""))
    .filter((t) => /[./]/.test(t) && !t.startsWith("http"));
  return tokens.some((t) => {
    if (t.includes("*")) {
      const rx = new RegExp("^" + t.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return listFiles(anchor).some((f) => rx.test(f));
    }
    return existsSync(join(anchor, t));
  });
}

const push = (arr: DoctorFinding[], f: DoctorFinding) => arr.push(f);

function escapeRx(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the text actually INVOKES the script (a runner followed by the
 * name), not merely contains it as a substring ("testing" must not wire
 * "test" -- audit finding, HX-006).
 */
function invokes(text: string, script: string): boolean {
  return new RegExp(
    `\\b(pnpm|npm|yarn|npx|bun)(\\s+run)?(\\s+(-{1,2}[\\w=-]+))*\\s+${escapeRx(script)}(?![\\w:.-])`,
  ).test(text);
}

/** Word-boundary mention; script names carry ":" so \b alone is wrong. */
function mentions(text: string, script: string): boolean {
  return new RegExp(`(^|[^\\w:.-])${escapeRx(script)}(?![\\w:.-])`, "m").test(text);
}

// ---------------------------------------------------- per-venture concerns

function checkAuthority(v: RegistryVenture, out: DoctorFinding[]): void {
  const a = v.anchor;
  const agentsDir = join(a, ".claude", "agents");
  const packs = listFiles(agentsDir, ".md");
  // gate tooling: a guard script, a settings deny-list covering risky git ops, or a pre-push hook
  const guardScripts = listFiles(join(a, "scripts")).filter((f) => /guard/i.test(f));
  let denyGate = false;
  try {
    const settings = JSON.parse(readIf(join(a, ".claude", "settings.json")) || "{}") as {
      permissions?: { deny?: string[] };
    };
    denyGate = (settings.permissions?.deny ?? []).some((d) => /push|reset|force|deploy/i.test(d));
  } catch {
    /* unreadable settings = no gate evidence */
  }
  // A pre-push hook only counts if its CONTENT is guard-shaped -- a stock
  // git-lfs hook is transport plumbing, not AUTHORITY (audit finding, HX-006).
  const guardShaped = (path: string) => /guard|gate|forbid|deny|confirm|--i-am-|self-authoriz/i.test(readIf(path));
  const prePush = guardShaped(join(a, ".git", "hooks", "pre-push")) || guardShaped(join(a, ".husky", "pre-push"));
  if (guardScripts.length === 0 && !denyGate && !prePush) {
    push(out, {
      venture: v.name, concern: "AUTHORITY", check: "gate-tooling", level: "red",
      message: "no gate tooling found (no guard script, no settings deny-list on risky ops, no guard-shaped pre-push hook)",
    });
  }
  // release path: a fleet (zone-set) requires a sanctioned release executor
  if (v.manifest.harness.modules["zone-set"] !== undefined) {
    if (!packs.some((p) => /release/i.test(p))) {
      push(out, {
        venture: v.name, concern: "AUTHORITY", check: "release-path", level: "red",
        message: "zone-set declared but no release pack in .claude/agents/ (gated ops need a sanctioned executor)",
      });
    }
  }
  // packs carry the never-self-authorize line
  const unsanctioned = packs.filter((p) => !/--i-am-|self-authoriz|founder|felix[ -]gated|gated op/i.test(readIf(join(agentsDir, p))));
  if (packs.length > 0 && unsanctioned.length > 0) {
    push(out, {
      venture: v.name, concern: "AUTHORITY", check: "no-self-authorize", level: "red",
      message: `packs without a gate/never-self-authorize line: ${unsanctioned.join(", ")}`,
    });
  }
}

function checkTruth(v: RegistryVenture, out: DoctorFinding[]): void {
  const a = v.anchor;
  const m = v.manifest;
  const declared: Record<string, string | null | undefined> = {
    "overlay.contract": m.harness.overlay?.contract,
    "overlay.canon": m.harness.overlay?.canon,
    "overlay.product": m.harness.overlay?.product,
    ...Object.fromEntries(Object.entries(m.state).map(([k, val]) => [`state.${k}`, val])),
  };
  let anyDeclared = false;
  for (const [key, value] of Object.entries(declared)) {
    if (value === undefined) continue;
    if (value === null) {
      push(out, { venture: v.name, concern: "TRUTH", check: "declared-paths", level: "yellow", message: `${key} declared absent (null)` });
      continue;
    }
    anyDeclared = true;
    if (!declarationResolves(a, value)) {
      push(out, {
        venture: v.name, concern: "TRUTH", check: "declared-paths", level: "red",
        message: `${key} does not resolve on disk: "${value}"`,
      });
    }
  }
  if (!anyDeclared && Object.keys(m.state).length === 0) {
    push(out, { venture: v.name, concern: "TRUTH", check: "declared-paths", level: "info", message: "no living surfaces declared" });
  }
  // volatile state (a generator's output file) must not be committed
  const generator = m.state.generator;
  if (generator && isGitRepoRoot(a)) {
    for (const file of [...generator.matchAll(/([A-Za-z0-9_-]+\.md)/g)].map((x) => x[1])) {
      const tracked = git(a, ["ls-files", "--", file]);
      if (tracked) {
        push(out, {
          venture: v.name, concern: "TRUTH", check: "volatile-state", level: "red",
          message: `generator output ${file} is git-tracked (generated state must not be committed)`,
        });
      }
    }
  }
}

function checkLabor(v: RegistryVenture, out: DoctorFinding[]): void {
  const agentsDir = join(v.anchor, ".claude", "agents");
  const packs = listFiles(agentsDir, ".md");
  const zonePacks = packs.filter((p) => /^zone-/.test(p));
  const zoneSet = v.manifest.harness.modules["zone-set"] as { fronts?: number } | undefined;
  if (zoneSet?.fronts !== undefined) {
    if (zonePacks.length !== zoneSet.fronts) {
      push(out, {
        venture: v.name, concern: "LABOR", check: "fronts-have-packs", level: "red",
        message: `zone-set declares ${zoneSet.fronts} fronts, found ${zonePacks.length} zone packs in .claude/agents/`,
      });
    }
  } else if (packs.length > 0) {
    push(out, {
      venture: v.name, concern: "LABOR", check: "fronts-have-packs", level: "yellow",
      message: `${packs.length} agent packs exist but no zone-set is declared in the manifest`,
    });
  } else {
    push(out, { venture: v.name, concern: "LABOR", check: "fronts-have-packs", level: "info", message: "no fronts declared, no packs found" });
  }
  const orphans = packs.filter((p) => !/^zone-/.test(p) && !/release|decision-recorder/i.test(p));
  if (orphans.length > 0) {
    push(out, {
      venture: v.name, concern: "LABOR", check: "orphan-packs", level: "yellow",
      message: `packs with no declared role (not zone/release/decision-recorder): ${orphans.join(", ")}`,
    });
  }
}

function checkQuality(v: RegistryVenture, studioAnchor: string | undefined, out: DoctorFinding[]): void {
  // A nested anchor may be wired by the studio repo's CI/hooks; a foreign repo may not.
  const inheritedStudio =
    studioAnchor !== undefined && v.anchor.startsWith(studioAnchor + "/") ? studioAnchor : undefined;
  const scripts = pkgScripts(v.anchor);
  const checkNames = Object.keys(scripts).filter((s) => /^(test|lint|typecheck|validate|audit|check)/.test(s));
  if (checkNames.length === 0) {
    push(out, {
      venture: v.name, concern: "QUALITY", check: "checks-exist", level: "red",
      message: existsSync(join(v.anchor, "package.json"))
        ? "no check suite in package.json scripts (test/lint/typecheck/validate/audit)"
        : "no check suite found (no package.json at the anchor)",
    });
    return;
  }
  const wiring = wiringText(v.anchor, inheritedStudio);
  const wired = checkNames.filter((s) => invokes(wiring, s));
  if (wired.length === 0) {
    push(out, {
      venture: v.name, concern: "QUALITY", check: "checks-wired", level: "red",
      message: `check suite exists (${checkNames.join(", ")}) but nothing invokes it (no CI workflow or commit hook reference)`,
    });
  }
}

const LEVERAGE_PATTERN = /^(scaffold|state|land|worksite|audit|validate|brain|lint|context|evolve|lingot|migrate|worktree|rf|doctor)([:.-]|$)/;

function checkLearning(v: RegistryVenture, out: DoctorFinding[]): void {
  const a = v.anchor;
  const scripts = Object.keys(pkgScripts(a)).filter((s) => LEVERAGE_PATTERN.test(s));
  if (scripts.length === 0) {
    push(out, { venture: v.name, concern: "LEARNING", check: "leverage-wired", level: "info", message: "no leverage-shaped scripts to wire" });
    return;
  }
  const routed: string[] = [];
  const contract = v.manifest.harness.overlay?.contract;
  if (contract) routed.push(readIf(join(a, contract.split(/[\s+]/)[0])));
  for (const sub of ["agents", "skills"]) {
    const dir = join(a, ".claude", sub);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const st = safeStat(p);
      if (st?.isFile()) routed.push(readIf(p));
      else if (st?.isDirectory()) for (const f of listFiles(p, ".md")) routed.push(readIf(join(p, f)));
    }
  }
  const corpus = routed.join("\n");
  const unrouted = scripts.filter((s) => !mentions(corpus, s));
  if (unrouted.length > 0) {
    push(out, {
      venture: v.name, concern: "LEARNING", check: "leverage-wired", level: "yellow",
      message: `leverage scripts not referenced by the contract or any pack/skill: ${unrouted.join(", ")} (built != connected)`,
    });
  }
}

// -------------------------------------------------------- studio plane

interface DbProject {
  readonly ref: string;
  readonly name: string;
  readonly org?: string;
  readonly region?: string;
  readonly status: "active" | "parked" | "unknown";
  readonly note?: string;
}

function checkDbCensus(ventures: readonly RegistryVenture[], registryDir: string, out: DoctorFinding[]): void {
  const censusPath = join(registryDir, "db-projects.yaml");
  if (!existsSync(censusPath)) {
    push(out, { venture: "studio", concern: "DB-CENSUS", check: "census-seed", level: "red", message: `no DB census at ${censusPath}` });
    return;
  }
  let projects: DbProject[];
  try {
    projects = (parseYaml(readFileSync(censusPath, "utf8")) as { projects?: DbProject[] }).projects ?? [];
  } catch (err) {
    push(out, { venture: "studio", concern: "DB-CENSUS", check: "census-seed", level: "red", message: `db-projects.yaml unparseable: ${(err as Error).message}` });
    return;
  }
  const refs = new Set(projects.map((p) => p.ref));
  const studioVenture = ventures.find((v) => v.kind === "studio");
  const owners = new Map<string, string[]>(); // ref -> venture names claiming ownership
  for (const v of ventures) {
    const claim = dbProject(v.manifest.db);
    if (!claim) {
      if (v.kind === "venture" || v.kind === "studio") {
        push(out, {
          venture: v.name, concern: "DB-CENSUS", check: "statefulness-declared", level: "yellow",
          message: "no db block: statefulness undeclared (declare a project, a studio tenancy, or stay stateless knowingly)",
        });
      }
      continue;
    }
    if (claim === "studio") {
      if (!dbProject(studioVenture?.manifest.db)) {
        push(out, { venture: v.name, concern: "DB-CENSUS", check: "tenancy", level: "red", message: "declares studio tenancy but the studio manifest claims no project" });
      } else if (!v.manifest.db?.schema) {
        push(out, { venture: v.name, concern: "DB-CENSUS", check: "tenancy", level: "red", message: "studio tenancy requires a schema (db.schema)" });
      }
      continue;
    }
    if (!refs.has(claim)) {
      push(out, {
        venture: v.name, concern: "DB-CENSUS", check: "claims-known-project", level: "red",
        message: `manifest claims project ${claim} which is not in db-projects.yaml`,
      });
      continue;
    }
    owners.set(claim, [...(owners.get(claim) ?? []), v.name]);
  }
  for (const p of projects) {
    const claimants = owners.get(p.ref) ?? [];
    if (claimants.length === 1) continue;
    if (claimants.length > 1) {
      push(out, {
        venture: "studio", concern: "DB-CENSUS", check: "one-owner", level: "red",
        message: `project ${p.name} (${p.ref}) claimed by ${claimants.length} manifests: ${claimants.join(", ")}`,
      });
    } else {
      push(out, {
        venture: "studio", concern: "DB-CENSUS", check: "unclaimed-project", level: p.status === "active" ? "red" : "yellow",
        message: `unclaimed ${p.status} project: ${p.name} (${p.ref})${p.note ? ` -- ${p.note}` : ""}`,
      });
    }
  }
}

function checkRepoCensus(ventures: readonly RegistryVenture[], studioAnchor: string | undefined, out: DoctorFinding[]): void {
  for (const v of ventures) {
    const repoRoot = isGitRepoRoot(v.anchor);
    const repo = v.manifest.repo;
    const claim = dbProject(v.manifest.db);
    if (repo) {
      const origin = git(v.anchor, ["remote", "get-url", "origin"]);
      if (!origin) {
        push(out, { venture: v.name, concern: "REPO-CENSUS", check: "origin-matches", level: "red", message: `repo block declares ${repo.github} but the anchor has no origin remote` });
      } else if (!origin.toLowerCase().includes(repo.github.toLowerCase())) {
        push(out, { venture: v.name, concern: "REPO-CENSUS", check: "origin-matches", level: "red", message: `origin ${origin} does not match declared repo ${repo.github}` });
      }
    } else if (repoRoot && (v.kind === "venture" || v.kind === "studio")) {
      push(out, { venture: v.name, concern: "REPO-CENSUS", check: "repo-declared", level: "yellow", message: "anchor is its own git repo but the manifest has no repo block" });
    }
    // The law: STATE FOLLOWS THE ANCHOR -- own DB <-> own repo; inside-studio <-> studio DB.
    const insideStudio = studioAnchor !== undefined && v.anchor !== studioAnchor && v.anchor.startsWith(studioAnchor + "/");
    if (claim && claim !== "studio" && insideStudio) {
      push(out, {
        venture: v.name, concern: "REPO-CENSUS", check: "state-follows-anchor", level: "red",
        message: `owns DB project ${claim} but is anchored inside the studio repo (law: own repo <-> own DB when stateful; inside-studio <-> studio DB)`,
      });
    }
    if (claim === "studio" && repoRoot) {
      push(out, {
        venture: v.name, concern: "REPO-CENSUS", check: "state-follows-anchor", level: "yellow",
        message: "own repo but studio-tenant DB (declare graduation intent or move state)",
      });
    }
  }
}

const HX_STATUS = new Set(["open", "acked", "in_progress", "blocked", "done"]);
const HX_REQUIRED = ["id", "from", "to", "type", "subject", "status", "created"] as const;
const STALE_DAYS = 7;

function checkExchange(v: RegistryVenture, out: DoctorFinding[]): void {
  // Attachments (HX-NNN-attachment-*) travel alongside a handoff and carry no frontmatter.
  const files = listFiles(v.anchor, ".md").filter((f) => /^HX-\d+/.test(f) && !/^HX-\d+-attachment/.test(f));
  for (const file of files) {
    const text = readIf(join(v.anchor, file));
    const fm = text.match(/^---\n([\s\S]*?)\n---/);
    if (!fm) {
      push(out, { venture: v.name, concern: "EXCHANGE", check: "handoff-schema", level: "red", message: `${file}: no frontmatter block` });
      continue;
    }
    let meta: Record<string, unknown>;
    try {
      meta = (parseYaml(fm[1]) ?? {}) as Record<string, unknown>;
    } catch {
      push(out, { venture: v.name, concern: "EXCHANGE", check: "handoff-schema", level: "red", message: `${file}: frontmatter unparseable` });
      continue;
    }
    const missing = HX_REQUIRED.filter((k) => meta[k] === undefined || meta[k] === null || meta[k] === "");
    if (missing.length > 0) {
      push(out, { venture: v.name, concern: "EXCHANGE", check: "handoff-schema", level: "red", message: `${file}: missing frontmatter fields: ${missing.join(", ")}` });
    }
    const status = String(meta.status ?? "");
    if (status && !HX_STATUS.has(status)) {
      push(out, { venture: v.name, concern: "EXCHANGE", check: "handoff-schema", level: "red", message: `${file}: status "${status}" not in ${[...HX_STATUS].join("/")}` });
    }
    if (status === "open" || status === "in_progress") {
      const created = new Date(String(meta.created ?? ""));
      if (!Number.isNaN(created.getTime())) {
        const age = Math.floor((Date.now() - created.getTime()) / 86_400_000);
        if (age > STALE_DAYS) {
          push(out, {
            venture: v.name, concern: "EXCHANGE", check: "stale-open", level: "yellow",
            message: `${file}: ${status} for ${age} days (created ${String(meta.created)}) -- act, block, or close`,
          });
        }
      }
    }
  }
  const remotes = git(v.anchor, ["remote"]);
  if (!remotes) {
    push(out, { venture: v.name, concern: "EXCHANGE", check: "remote-backup", level: "yellow", message: "exchange has no git remote (backup) -- warn until Felix creates one" });
  }
}

// ------------------------------------------------------------ assembly

const FULL_KINDS = new Set(["venture", "studio"]);

function doctorVenture(v: RegistryVenture, studioAnchor: string | undefined): VentureDoctorReport {
  const findings: DoctorFinding[] = [];
  checkTruth(v, findings);
  if (FULL_KINDS.has(v.kind)) {
    checkAuthority(v, findings);
    checkLabor(v, findings);
    checkQuality(v, studioAnchor, findings);
    checkLearning(v, findings);
  }
  if (v.kind === "channel") checkExchange(v, findings);
  const concernSet = FULL_KINDS.has(v.kind) ? [...CONCERNS] : [...new Set(findings.map((f) => f.concern))];
  const concerns: ConcernVerdict[] = concernSet.map((c) => {
    const mine = findings.filter((f) => f.concern === c);
    return {
      concern: c,
      verdict: mine.some((f) => f.level === "red") ? "red" : "green",
      reds: mine.filter((f) => f.level === "red").length,
      yellows: mine.filter((f) => f.level === "yellow").length,
    };
  });
  return { name: v.name, kind: v.kind, anchor: v.anchor, placement: v.placement, concerns, findings };
}

export function doctorAll(root: string, opts: { write?: boolean } = {}): { report: DoctorReport; registry: Registry } {
  const registry = sweep(root, { write: opts.write ?? false });
  const studio = registry.ventures.find((v) => v.kind === "studio");
  const registryDir = studio?.manifest.studio ? join(studio.anchor, studio.manifest.studio.registry) : undefined;
  const ventures = registry.ventures.map((v) => doctorVenture(v, studio?.anchor));
  const studioFindings: DoctorFinding[] = [];
  for (const f of registry.findings.filter((f) => f.level === "red")) {
    studioFindings.push({ venture: "studio", concern: "REGISTRY", check: "sweep", level: "red", message: f.message });
  }
  if (registryDir) checkDbCensus(registry.ventures, registryDir, studioFindings);
  checkRepoCensus(registry.ventures, studio?.anchor, studioFindings);
  const all = [...ventures.flatMap((v) => v.findings), ...studioFindings];
  const totals = {
    reds: all.filter((f) => f.level === "red").length,
    yellows: all.filter((f) => f.level === "yellow").length,
    infos: all.filter((f) => f.level === "info").length,
  };
  const report: DoctorReport = {
    generated: new Date().toISOString(),
    tool: "lingot doctor (v0, P3)",
    ventures,
    studioFindings,
    totals,
    verdict: totals.reds > 0 ? "red" : "green",
  };
  return { report, registry };
}

export function doctorOne(anchor: string, name: string, kind: string, manifest: VentureManifest, studioAnchor?: string): VentureDoctorReport {
  const v: RegistryVenture = {
    name, kind, owners: manifest.identity.owners, anchor, relpath: anchor,
    placement: "in-place", manifestPath: join(anchor, "lingot.json"), manifest,
  };
  return doctorVenture(v, studioAnchor);
}

// ------------------------------------------------------------- rendering

const MARK = { red: "✗", yellow: "△", info: "·" } as const;

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`lingot doctor -- ${report.generated.slice(0, 16).replace("T", " ")}`);
  for (const v of report.ventures) {
    const verdictLine = v.concerns.map((c) => `${c.concern.slice(0, 5)}:${c.verdict === "red" ? "RED" : "ok"}`).join(" ");
    lines.push("");
    lines.push(`${v.name} (${v.kind}${v.placement === "parked" ? ", parked manifest" : ""})  ${verdictLine}`);
    for (const f of v.findings) lines.push(`  ${MARK[f.level]} [${f.concern}/${f.check}] ${f.message}`);
  }
  if (report.studioFindings.length > 0) {
    lines.push("");
    lines.push("studio plane");
    for (const f of report.studioFindings) lines.push(`  ${MARK[f.level]} [${f.concern}/${f.check}] (${f.venture}) ${f.message}`);
  }
  lines.push("");
  lines.push(`TOTALS: ${report.totals.reds} red · ${report.totals.yellows} yellow · ${report.totals.infos} info`);
  lines.push(`VERDICT: ${report.verdict.toUpperCase()}`);
  return lines.join("\n");
}

export function renderBaselineMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("# Doctor baseline -- the honest red list (P3, HX-006)");
  lines.push("");
  lines.push(`> Generated ${report.generated.slice(0, 10)} by \`pnpm lingot doctor --all --write\`. This is the`);
  lines.push("> deliverable: reds are EXPECTED and wanted (honesty over green). Fixes are the burn-down");
  lines.push("> that follows, each its own reviewable change. The pre-commit ratchet compares against");
  lines.push("> `doctor.json` and fails only on NEW reds; re-baseline by re-running with `--write` after");
  lines.push("> a reviewed fix.");
  lines.push("");
  lines.push("## Verdict grid");
  lines.push("");
  lines.push("| venture | kind | " + CONCERNS.map((c) => c.toLowerCase()).join(" | ") + " |");
  lines.push("|---|---|" + CONCERNS.map(() => "---").join("|") + "|");
  for (const v of report.ventures) {
    const cells = CONCERNS.map((c) => {
      const cv = v.concerns.find((x) => x.concern === c);
      if (!cv) return "--";
      return cv.verdict === "red" ? `**RED** (${cv.reds})` : cv.yellows > 0 ? `green (${cv.yellows}y)` : "green";
    });
    lines.push(`| ${v.name} | ${v.kind} | ${cells.join(" | ")} |`);
  }
  lines.push("");
  lines.push(`Studio plane: ${report.studioFindings.filter((f) => f.level === "red").length} red, ` +
    `${report.studioFindings.filter((f) => f.level === "yellow").length} yellow. ` +
    `Totals: **${report.totals.reds} red** · ${report.totals.yellows} yellow · ${report.totals.infos} info.`);
  lines.push("");
  lines.push("## Findings");
  lines.push("");
  for (const v of report.ventures) {
    if (v.findings.length === 0) continue;
    lines.push(`### ${v.name}`);
    lines.push("");
    for (const f of v.findings) lines.push(`- ${f.level.toUpperCase()} \`${f.concern}/${f.check}\`: ${f.message}`);
    lines.push("");
  }
  if (report.studioFindings.length > 0) {
    lines.push("### studio plane");
    lines.push("");
    for (const f of report.studioFindings) lines.push(`- ${f.level.toUpperCase()} \`${f.concern}/${f.check}\` (${f.venture}): ${f.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Stable identity for the ratchet: venture|concern|check|message. */
export function findingKeys(report: DoctorReport): Set<string> {
  const keys = new Set<string>();
  for (const f of [...report.ventures.flatMap((v) => v.findings), ...report.studioFindings]) {
    if (f.level === "red") keys.add(`${f.venture}|${f.concern}|${f.check}|${f.message}`);
  }
  return keys;
}
