import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic prompt-quality lint (W2 of the prompt-design buildout,
 * research/responses/195-response.md). The research pass measured lint-worthy
 * violations across the kernel's compiled artifacts (127 em dashes, 10/10
 * empty front descriptions, 63 hollow OVERLAY placeholders, codec drift like
 * "built U+2260 done" vs "built != done") and named the corollary: these
 * checks live in compiler code, never delegated to a model at any tier -- a
 * banned character or a hollow slot is a fact about the text, not a judgment
 * call. Every rule below is a pure function over already-read file content:
 * no filesystem writes, no network, no randomness, same input always yields
 * the same findings.
 */

export interface LintFinding {
  rule: "em-dash" | "done-line" | "front-desc" | "hollow-slot" | "codec-symbol";
  file: string;      // repo-relative or given path
  line: number;      // 1-indexed
  detail: string;
  severity: "error" | "warn";
}

const EM_DASH = "\u2014";
const NOT_EQUAL = "\u2260";
const RIGHT_ARROW = "\u2192";

/** A prompt unit's Done contract: a "Done" heading (any level) or a bolded **Done** marker -- the house's "Done = reviewable" convention (harness-compile.ts's PACK_SECTIONS is the same shape one layer up). */
const DONE_CONTRACT = /(^|\n)#{1,6}\s*Done\b|\*\*Done\*\*/;

/** A compiled zone pack's path shape -- the only compiled-artifact target that is itself a dispatched prompt unit and so owes its own Done contract. */
const ZONE_PACK_PATH = /packs\/zone-.+\.md$/;

/** em-dash: the house bans U+2014 in every prose artifact (use "--" instead); each offending line names its own count. */
function lintEmDash(file: string, lines: readonly string[]): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((line, i) => {
    const count = line.split(EM_DASH).length - 1;
    if (count > 0) out.push({ rule: "em-dash", file, line: i + 1, detail: `${count} em dash(es) on this line`, severity: "error" });
  });
  return out;
}

/** codec-symbol: U+2260/U+2192 are Unicode drift away from the house's ASCII codec (!=, ->) that protects canonical operational phrases from paraphrase. */
function lintCodecSymbol(file: string, lines: readonly string[]): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((line, i) => {
    if (line.includes(NOT_EQUAL)) out.push({ rule: "codec-symbol", file, line: i + 1, detail: "use ASCII != (codec canon)", severity: "error" });
    if (line.includes(RIGHT_ARROW)) out.push({ rule: "codec-symbol", file, line: i + 1, detail: "use -> (codec canon)", severity: "error" });
  });
  return out;
}

/** done-line: file-level, reported at line 1 when missing -- a prompt unit that states no Done contract anywhere in its body. */
function lintDoneLine(file: string, content: string): LintFinding[] {
  if (DONE_CONTRACT.test(content)) return [];
  return [{ rule: "done-line", file, line: 1, detail: "prompt unit lacks a Done = contract", severity: "error" }];
}

/** hollow-slot: compiled-artifact-only -- a template slot or overlay placeholder that leaked into shipped output unfilled. */
function lintHollowSlot(file: string, lines: readonly string[]): LintFinding[] {
  const out: LintFinding[] = [];
  lines.forEach((line, i) => {
    if (/<UNRESOLVED:[^>]*>/.test(line)) out.push({ rule: "hollow-slot", file, line: i + 1, detail: "unresolved template slot", severity: "error" });
    if (/<[^>\n]*OVERLAY[^>\n]*>/.test(line)) out.push({ rule: "hollow-slot", file, line: i + 1, detail: "unfilled overlay placeholder", severity: "error" });
  });
  return out;
}

/** front-desc: AGENTS.md-only -- inside "## Fronts", a bullet that named a front but rendered no description (the readCharters gap fixed in harness-emit.ts). */
function lintFrontDesc(file: string, content: string): LintFinding[] {
  const out: LintFinding[] = [];
  let inFronts = false;
  content.split("\n").forEach((line, i) => {
    if (/^##\s+Fronts\b/.test(line)) {
      inFronts = true;
      return;
    }
    if (inFronts && /^##\s+/.test(line)) {
      inFronts = false;
      return;
    }
    if (inFronts && /^-\s+\*\*[^*]+\*\*\s+--\s*$/.test(line)) {
      out.push({ rule: "front-desc", file, line: i + 1, detail: "front has empty description", severity: "warn" });
    }
  });
  return out;
}

/** Every ".md" filename directly in `dir`, sorted for a deterministic scan order. A missing dir yields no files (safe -- callers scan optional dirs like kernelDir/skills). */
function listMd(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
}

/** Top-level kernel files that are themselves a dispatched prompt unit and so owe a Done contract -- contract-base.md is deliberately excluded (its Done-law lives inside its operating bullets, not as its own unit-level contract). */
const DONE_CHECKED_TOP_LEVEL = new Set(["pack-template.md", "boot-skill.md"]);

/**
 * Lint every kernel source: the top-level *.md templates plus every
 * skills/*.md. em-dash + codec-symbol are house-wide prose law and apply to
 * all of them; done-line applies only to the individually-dispatched prompt
 * units (skills/*.md, pack-template.md, boot-skill.md) -- never
 * contract-base.md.
 */
export function lintKernelSources(kernelDir: string): LintFinding[] {
  const out: LintFinding[] = [];
  for (const name of listMd(kernelDir)) {
    const content = readFileSync(join(kernelDir, name), "utf8");
    const lines = content.split("\n");
    out.push(...lintEmDash(name, lines), ...lintCodecSymbol(name, lines));
    if (DONE_CHECKED_TOP_LEVEL.has(name)) out.push(...lintDoneLine(name, content));
  }
  const skillsDir = join(kernelDir, "skills");
  for (const name of listMd(skillsDir)) {
    const rel = `skills/${name}`;
    const content = readFileSync(join(skillsDir, name), "utf8");
    const lines = content.split("\n");
    out.push(...lintEmDash(rel, lines), ...lintCodecSymbol(rel, lines), ...lintDoneLine(rel, content));
  }
  return out;
}

/** Lint a compiled AGENTS.md: em-dash + codec-symbol (house-wide) + front-desc (this target only). */
export function lintAgentsMd(path: string, content: string): LintFinding[] {
  const lines = content.split("\n");
  return [...lintEmDash(path, lines), ...lintCodecSymbol(path, lines), ...lintFrontDesc(path, content)];
}

/**
 * Lint one compiled artifact (any harness-emit.ts target, or a shadow
 * compileHarness output): em-dash + codec-symbol + hollow-slot on all of
 * them; done-line additionally on a compiled zone pack (packs/zone-*.md),
 * the compiled shape of a dispatched prompt unit.
 */
export function lintCompiledArtifact(rel: string, content: string): LintFinding[] {
  const lines = content.split("\n");
  const out = [...lintEmDash(rel, lines), ...lintCodecSymbol(rel, lines), ...lintHollowSlot(rel, lines)];
  if (ZONE_PACK_PATH.test(rel)) out.push(...lintDoneLine(rel, content));
  return out;
}

/** One line per finding ("  <severity> <rule> <file>:<line> <detail>"), closed by a summary count line. */
export function formatLintFindings(findings: LintFinding[]): string {
  const lines = findings.map((f) => `  ${f.severity} ${f.rule} ${f.file}:${f.line} ${f.detail}`);
  const errors = findings.filter((f) => f.severity === "error").length;
  const warnings = findings.filter((f) => f.severity === "warn").length;
  lines.push(`harness lint: ${errors} error(s), ${warnings} warning(s)`);
  return lines.join("\n");
}
