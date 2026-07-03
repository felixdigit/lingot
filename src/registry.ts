import { existsSync, readdirSync, readFileSync, realpathSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";
import { loadVentureManifest, type VentureManifest } from "./venture";

/**
 * `lingot registry --sweep <root>` -- the census.
 * Finds every venture manifest under the root (direct children + the studio
 * manifest's scan globs + parked manifests in the studio registry), flags every
 * manifest-less candidate directory, joins the studio triage list, and writes
 * registry.json. Absence from the registry is itself a red finding.
 */

export interface RegistryVenture {
  readonly name: string;
  readonly kind: string;
  readonly owners: readonly string[];
  /** Absolute anchor directory. */
  readonly anchor: string;
  /** Anchor relative to the sweep root ("." for the root itself). */
  readonly relpath: string;
  readonly placement: "in-place" | "parked";
  readonly manifestPath: string;
  readonly parkedNote?: string;
  readonly manifest: VentureManifest;
}

export interface TriageEntry {
  readonly path: string;
  readonly classification?: string;
  readonly proposal: "adopt" | "archive" | "delete";
  readonly rationale: string;
  readonly status: "proposed" | "approved" | "rejected";
}

export interface RegistryStray {
  readonly relpath: string;
  readonly classification: string;
  readonly worktree?: { readonly of: string; readonly branch: string };
  readonly triage?: TriageEntry;
}

export interface Finding {
  readonly level: "red" | "yellow" | "info";
  readonly message: string;
}

export interface Registry {
  readonly generated: string;
  readonly root: string;
  readonly tool: string;
  readonly ventures: readonly RegistryVenture[];
  readonly strays: readonly RegistryStray[];
  readonly findings: readonly Finding[];
  readonly verdict: "green" | "red";
}

export function expandTilde(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/**
 * Canonical absolute path: tilde-expanded, resolved, and symlink-free where the
 * path exists (audit note, HX-005). Anchors and candidates are always compared
 * in this form, so a symlinked root and a realpath'd anchor still match.
 */
export function canonicalPath(path: string): string {
  const resolved = resolve(expandTilde(path));
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Detects a linked git worktree: `.git` is a file whose gitdir points into ".git/worktrees/". */
function detectWorktree(dir: string): { of: string; branch: string } | undefined {
  const gitPath = join(dir, ".git");
  if (!existsSync(gitPath) || !statSync(gitPath).isFile()) return undefined;
  const content = readFileSync(gitPath, "utf8").trim();
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return undefined;
  const gitdir = resolve(dir, match[1]);
  const wtIndex = gitdir.indexOf("/.git/worktrees/");
  if (wtIndex === -1) return undefined;
  const of = gitdir.slice(0, wtIndex);
  let branch = "unknown";
  const headPath = join(gitdir, "HEAD");
  if (existsSync(headPath)) {
    const head = readFileSync(headPath, "utf8").trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    branch = ref ? ref[1] : head.slice(0, 8);
  }
  return { of: basename(of), branch };
}

function listChildDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isDirectory());
}

/** Expand a studio scan glob of the shape "dir/*" relative to the studio anchor. */
function expandScanGlob(studioAnchor: string, glob: string): string[] {
  if (glob.endsWith("/*")) return listChildDirs(join(studioAnchor, glob.slice(0, -2)));
  const single = join(studioAnchor, glob);
  return existsSync(single) && statSync(single).isDirectory() ? [single] : [];
}

function loadTriage(registryDir: string, findings: Finding[]): TriageEntry[] {
  const triagePath = join(registryDir, "triage.yaml");
  if (!existsSync(triagePath)) {
    findings.push({ level: "yellow", message: `no triage list at ${triagePath}` });
    return [];
  }
  try {
    const doc = parseYaml(readFileSync(triagePath, "utf8")) as { strays?: TriageEntry[] };
    return doc?.strays ?? [];
  } catch (err) {
    findings.push({ level: "red", message: `triage.yaml unparseable: ${(err as Error).message}` });
    return [];
  }
}

export function sweep(rootArg: string): Registry {
  const root = canonicalPath(rootArg);
  const findings: Finding[] = [];
  const ventures: RegistryVenture[] = [];
  const strays: RegistryStray[] = [];

  // Pass 1: direct children of the root (the root itself is not a candidate).
  // Candidates are keyed by canonical path, so a transitional symlink (e.g. a
  // renamed repo keeping its old name for tooling compat) dedupes onto the real
  // directory and is surfaced as an info finding rather than a second venture.
  const candidates = new Map<string, string>(); // canonical abs path -> relpath
  const addCandidate = (dir: string) => {
    const canon = canonicalPath(dir);
    if (canon !== dir) {
      findings.push({
        level: "info",
        message: `symlinked candidate ${relative(root, dir)} -> ${relative(root, canon)}; censused at the real path`,
      });
    }
    if (!candidates.has(canon)) candidates.set(canon, relative(root, canon));
  };
  for (const dir of listChildDirs(root)) addCandidate(dir);

  // Pass 2: resolve manifests at candidates; find the studio.
  const manifested = new Map<string, RegistryVenture>(); // abs anchor -> venture
  let studio: RegistryVenture | undefined;
  const takeManifest = (anchor: string, manifestPath: string, placement: "in-place" | "parked", parkedNote?: string) => {
    const { manifest, errors } = loadVentureManifest(manifestPath);
    if (!manifest) {
      for (const e of errors) findings.push({ level: "red", message: e });
      return;
    }
    if (manifested.has(anchor)) {
      findings.push({
        level: "red",
        message: `duplicate manifest for ${anchor}: ${manifestPath} vs ${manifested.get(anchor)!.manifestPath}`,
      });
      return;
    }
    const venture: RegistryVenture = {
      name: manifest.identity.name,
      kind: manifest.identity.kind,
      owners: manifest.identity.owners,
      anchor,
      relpath: relative(root, anchor) || ".",
      placement,
      manifestPath,
      ...(parkedNote ? { parkedNote } : {}),
      manifest,
    };
    manifested.set(anchor, venture);
    ventures.push(venture);
    if (manifest.identity.kind === "studio") studio = venture;
  };

  for (const [dir] of candidates) {
    const manifestPath = join(dir, "lingot.json");
    if (existsSync(manifestPath)) takeManifest(dir, manifestPath, "in-place");
  }

  // Pass 3: the studio widens the census -- scan globs + parked manifests.
  let registryDir: string | undefined;
  if (studio?.manifest.studio) {
    registryDir = join(studio.anchor, studio.manifest.studio.registry);
    for (const glob of studio.manifest.studio.scan) {
      for (const dir of expandScanGlob(studio.anchor, glob)) {
        const canon = canonicalPath(dir);
        addCandidate(dir);
        const manifestPath = join(canon, "lingot.json");
        if (existsSync(manifestPath) && !manifested.has(canon)) takeManifest(canon, manifestPath, "in-place");
      }
    }
    const parkedDir = join(registryDir, "ventures");
    if (existsSync(parkedDir)) {
      for (const file of readdirSync(parkedDir).filter((f) => f.endsWith(".lingot.json"))) {
        const manifestPath = join(parkedDir, file);
        const { manifest, errors } = loadVentureManifest(manifestPath);
        if (!manifest) {
          for (const e of errors) findings.push({ level: "red", message: e });
          continue;
        }
        if (!manifest.anchor) {
          findings.push({ level: "red", message: `${manifestPath}: parked manifest without anchor field` });
          continue;
        }
        const anchor = canonicalPath(manifest.anchor);
        if (!existsSync(anchor)) {
          findings.push({ level: "red", message: `${manifestPath}: anchor ${manifest.anchor} does not exist` });
          continue;
        }
        if (existsSync(join(anchor, "lingot.json"))) {
          findings.push({
            level: "red",
            message: `${anchor} has an in-place manifest AND a parked copy (${file}); remove the parked copy`,
          });
          continue;
        }
        takeManifest(anchor, manifestPath, "parked", manifest.parked);
      }
    }
  } else {
    findings.push({ level: "red", message: `no studio-kind manifest found under ${root}; the registry has no home` });
  }

  // Pass 4: strays = candidates without a manifest, joined to the triage list.
  const triage = registryDir ? loadTriage(registryDir, findings) : [];
  const triageByPath = new Map(triage.map((t) => [t.path, t]));
  const matchedTriage = new Set<string>();
  for (const [dir, relpath] of [...candidates].sort((a, b) => a[1].localeCompare(b[1]))) {
    if (manifested.has(dir)) continue;
    const worktree = detectWorktree(dir);
    const entry = triageByPath.get(relpath);
    if (entry) matchedTriage.add(relpath);
    strays.push({
      relpath,
      classification: entry?.classification ?? (worktree ? "worktree" : "unknown"),
      ...(worktree ? { worktree } : {}),
      ...(entry ? { triage: entry } : {}),
    });
    if (!entry) {
      findings.push({ level: "red", message: `untriaged stray: ${relpath} (add an entry to registry/triage.yaml)` });
    }
  }
  for (const t of triage) {
    if (!matchedTriage.has(t.path)) {
      findings.push({ level: "info", message: `stale triage entry: ${t.path} (no matching manifest-less candidate)` });
    }
  }

  const registry: Registry = {
    generated: new Date().toISOString(),
    root,
    tool: "lingot registry --sweep (v0, P1)",
    ventures: [...ventures].sort((a, b) => a.name.localeCompare(b.name)),
    strays,
    findings,
    verdict: findings.some((f) => f.level === "red") ? "red" : "green",
  };

  if (registryDir) {
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(join(registryDir, "registry.json"), JSON.stringify(registry, null, 2) + "\n");
  }
  return registry;
}

/** Human report for the terminal. */
export function formatSweepReport(registry: Registry): string {
  const lines: string[] = [];
  lines.push(`lingot registry sweep -- ${registry.root}`);
  lines.push("");
  lines.push(`VENTURES (${registry.ventures.length})`);
  for (const v of registry.ventures) {
    const db = v.manifest.identity.aliases?.db;
    lines.push(
      `  ${v.name.padEnd(20)} ${v.kind.padEnd(8)} owners: ${v.owners.join("+").padEnd(12)} ` +
        `${v.placement === "parked" ? "PARKED -> " : ""}${v.relpath}${db ? `  db: ${db}` : ""}`,
    );
  }
  lines.push("");
  lines.push(`STRAYS (${registry.strays.length})`);
  for (const s of registry.strays) {
    const t = s.triage;
    const wt = s.worktree ? ` [worktree of ${s.worktree.of} @ ${s.worktree.branch}]` : "";
    lines.push(
      `  ${s.relpath.padEnd(36)} ${s.classification.padEnd(14)}${wt} ` +
        (t ? `-> ${t.proposal} (${t.status})` : "-> UNTRIAGED"),
    );
  }
  if (registry.findings.length > 0) {
    lines.push("");
    lines.push("FINDINGS");
    for (const f of registry.findings) lines.push(`  [${f.level.toUpperCase()}] ${f.message}`);
  }
  lines.push("");
  lines.push(`VERDICT: ${registry.verdict.toUpperCase()}`);
  return lines.join("\n");
}
