import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderTemplate } from "./harness-compile";
import type { HarnessManifest } from "./harness-manifest";
import type { TierEntry } from "./harness-kernel";

const KERNEL_CONTRACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "kernel", "contract-base.md");

/**
 * Render the kernel operating contract (contract-base.md) through a v1 context.
 * The template's venture-specific sections are module-conditional; this maps the
 * v1 manifest (governance, state, overlay, perimeter) into the module-shaped
 * context the template expects, so a venture that declares its governance gets
 * the full contract (gate wall, verification, hard gates, cold boot), and one
 * that doesn't gets the generic operating discipline with those sections cleanly
 * dropped. Missing kernel file -> empty (safe).
 */
function renderKernelContract(resolved: HarnessManifest): string {
  let template: string;
  try {
    template = readFileSync(KERNEL_CONTRACT_PATH, "utf8");
  } catch {
    return "";
  }
  const cap = (s: string): string => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const g = resolved.governance ?? {};
  const ctx: Record<string, unknown> = {
    name: resolved.identity.name,
    title: cap(resolved.identity.name),
    founder: cap(resolved.identity.owners[0] ?? "the founder"),
    aliases: resolved.identity.aliases ?? {},
    overlay: resolved.overlay ?? {},
    state: resolved.state ?? {},
    db: { schema: resolved.state?.store?.schema },
    gateWallList: (g.gated ?? []).join(", "),
    modules: {
      "zone-set": resolved.context?.charters ? { fronts: true } : undefined,
      "gate-wall": g.gated && g.gated.length ? { gated: g.gated, enforcement: g.enforcement } : undefined,
      verification: g.verification ? { required: true, shape: g.verification } : undefined,
      comms: g.comms,
      deploy: resolved.perimeter?.deploy?.surface ? { surface: resolved.perimeter.deploy.surface } : undefined,
      design: g.design_gate ? { gate: g.design_gate } : undefined,
    },
  };
  return renderTemplate(template, ctx).trimEnd();
}

interface Front {
  readonly name: string;
  readonly description: string;
}

/**
 * Fallback front description when the charter carries no "## description"
 * header (measured, research/responses/195-response.md: 10/10 compiled front
 * bullets rendered with an empty description because the briefs don't carry
 * that header). Reads forward from the end of the H1 title line, skipping
 * blanks, HTML comment lines, horizontal rules, and heading lines, and takes
 * the first real content line as the one-line summary -- stripping a leading
 * blockquote/bullet marker, collapsing internal whitespace, and truncating to
 * 160 characters at a word boundary (only when truncation actually happens).
 */
function fallbackFrontDescription(text: string, titleEnd: number): string {
  let inComment = false;
  for (const raw of text.slice(titleEnd).split("\n")) {
    const line = raw.trim();
    if (inComment) {
      if (line.includes("-->")) inComment = false;
      continue;
    }
    if (!line) continue;
    if (line.includes("<!--")) {
      if (!line.includes("-->")) inComment = true;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) continue; // a horizontal rule
    if (/^#{1,6}\s/.test(line)) continue; // a heading line
    if (/^`{3,}/.test(line)) continue; // a code-fence line is never a description
    // House style holds on COMPILED prose even when the source brief predates
    // it: em dashes and codec symbols normalize to ASCII (the lint gates the
    // emitted artifact, so emit must produce what the lint accepts).
    const collapsed = line
      .replace(/^(>|-|\*)\s+/, "")
      .replace(/—/g, "--")
      .replace(/≠/g, "!=")
      .replace(/→/g, "->")
      .replace(/\s+/g, " ")
      .trim();
    if (!collapsed) continue;
    if (/^\**(date|status|inputs?|owners?|authors?|for)\**\s*:/i.test(collapsed)) continue; // brief metadata, not a description
    if (collapsed.length <= 160) return collapsed;
    const cut = collapsed.slice(0, 160);
    const lastSpace = cut.lastIndexOf(" ");
    return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trimEnd() + "...";
  }
  return "";
}

/**
 * Read the venture's front charters (context.charters, e.g. "docs/fronts/zone-*.md")
 * relative to the anchor, and extract each front's name + one-line description.
 * Minimal single-`*` glob over one directory. Missing dir -> no fronts (safe).
 * Description source order: the explicit "## description" header first;
 * fallbackFrontDescription (the first real content line after the title)
 * when that header is absent or empty.
 */
function readCharters(anchor: string, glob: string): Front[] {
  const slash = glob.lastIndexOf("/");
  const dir = slash >= 0 ? glob.slice(0, slash) : ".";
  const pat = slash >= 0 ? glob.slice(slash + 1) : glob;
  const rx = new RegExp("^" + pat.replace(/[.+]/g, "\\$&").replace(/\*/g, ".*") + "$");
  let files: string[];
  try {
    files = readdirSync(join(anchor, dir)).filter((f) => rx.test(f)).sort();
  } catch {
    return [];
  }
  const out: Front[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(join(anchor, dir, f), "utf8");
    } catch {
      continue;
    }
    const nameM = text.match(/^#\s*(.+?)\s*$/m);
    const descM = text.match(/##\s*description\s*\n+([\s\S]*?)(?:\n##\s|$)/i);
    const headerDescription = (descM?.[1] ?? "").trim().split("\n")[0].trim();
    const titleEnd = nameM ? (nameM.index ?? 0) + nameM[0].length : 0;
    out.push({
      name: (nameM?.[1] ?? f).replace(/\s*\(charter\)\s*$/i, "").trim(),
      description: headerDescription || fallbackFrontDescription(text, titleEnd),
    });
  }
  return out;
}

/**
 * Compile targets -- the render/emit stage (Phase 0, 0.2b). A target is a pure
 * renderer over the resolved manifest, producing a content-addressed,
 * provenance-stamped artifact (docs/harness/03 Section 4 + 7). Deterministic:
 * no clock, no network, no randomness -- so the same resolved manifest always
 * yields the same artifact + hash. 0.2b ships the deploy-scope target only
 * (closes symptom S1); more targets (context bundle, packs, AGENTS.md, tier
 * table) land in later slices.
 */

export interface CompiledArtifact {
  /** Which target produced this (e.g. "deploy-scope"). */
  readonly target: string;
  /** Where it materializes, relative to the project anchor. */
  readonly path: string;
  readonly content: string;
  /** sha256 of content -- the content-address (A4). */
  readonly hash: string;
  /** Which resolved-manifest fields + kernel version this came from. No timestamp (determinism). */
  readonly provenance: { readonly kernel: string; readonly from: readonly string[] };
}

const DO_NOT_EDIT = "# GENERATED by the harness -- DO NOT EDIT. Recompile via `harness compile`.";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Deploy-scope target: the project perimeter -> the deploy ignore file. The
 * eradication mechanism for S1 (foreign monorepo weight leaking into a deploy):
 * the ignore file is generated from perimeter.exclude, never hand-authored, so a
 * deploy physically cannot reach outside the declared perimeter.
 */
export function emitDeployScope(resolved: HarnessManifest, kernelVersion: string): CompiledArtifact {
  const excludes = resolved.perimeter?.exclude ?? [];
  const deployRoot = resolved.perimeter?.deploy?.root ?? ".";
  // The ignore file lands at the deploy root (where the deploy actually uploads
  // from), relative to the anchor -- e.g. "../.." for a repo-root Vercel deploy.
  const path = deployRoot === "." ? ".vercelignore" : `${deployRoot.replace(/\/+$/, "")}/.vercelignore`;
  const lines = [
    DO_NOT_EDIT,
    `# Source: agency perimeter.exclude (${excludes.length} pattern(s)) + kernel ${kernelVersion}`,
    "",
    ...excludes,
  ];
  const content = lines.join("\n") + "\n";
  return {
    target: "deploy-scope",
    path,
    content,
    hash: sha256(content),
    provenance: { kernel: kernelVersion, from: ["perimeter.exclude", "perimeter.deploy.root"] },
  };
}

/**
 * AGENTS.md target: the portable operating-instructions artifact (docs/harness/
 * 20). The full operating contract rendered from the kernel (how-we-operate,
 * hard gates, the gate wall, verification, cold boot) through the venture's
 * governance + overlay + state, PLUS the v1-native additions the kernel contract
 * predates (model routing, eval gates) and the fronts generated from the
 * charters. This is what lets AGENTS.md stand in for the venture's contract.
 */
export function emitAgentsMd(resolved: HarnessManifest, kernelVersion: string, anchor?: string): CompiledArtifact {
  const contract = renderKernelContract(resolved);
  const routing = resolved.routing;
  const gates = resolved.evaluation?.gates ?? {};

  const lines: string[] = [
    "<!-- GENERATED by the harness -- DO NOT EDIT. Change the manifest/charters or the kernel, then recompile. -->",
    `<!-- kernel ${kernelVersion} -->`,
    "",
  ];
  if (contract) lines.push(contract, "");
  lines.push(
    "## Model routing (route by the judgment the task needs)",
    `- default tier: \`${routing?.default ?? "scoped"}\``,
    `- available tiers: ${(routing?.tiers ?? []).map((t) => `\`${t}\``).join(", ") || "(inherited from the kernel)"}`,
    ...Object.entries(routing?.overrides ?? {}).map(([role, tier]) => `- ${role} runs on \`${tier}\``),
    "- gates, refuters, and the orchestrator run on a judgment tier; only mechanical labor routes down.",
  );
  if ((gates.promote ?? []).length > 0 || (gates.tier_swap ?? []).length > 0) {
    lines.push(
      "",
      "## Eval gates",
      `- promotion: ${(gates.promote ?? []).join(", ") || "(none)"}`,
      `- tier-swap: ${(gates.tier_swap ?? []).join(", ") || "(none)"}`,
    );
  }

  const fronts = anchor && resolved.context?.charters ? readCharters(anchor, resolved.context.charters) : [];
  if (fronts.length) {
    lines.push("", "## Fronts -- the org chart (generated from the charters)");
    // A charter with no extractable description renders a bare bullet -- never
    // a dangling trailing " -- " (that shape is exactly what harness-lint's
    // front-desc rule flags).
    for (const fr of fronts) lines.push(fr.description ? `- **${fr.name}** -- ${fr.description}` : `- **${fr.name}**`);
  }

  // Venture overlay inclusion: a hand-authored docs/operating-overlay.md is the
  // venture's operational law the kernel spine does not carry (project pins,
  // hazards, local conventions). Included verbatim so the compiled contract is
  // SELF-CONTAINED -- the mechanism that let CLAUDE.md retire (H-10).
  let overlayIncluded = false;
  if (anchor) {
    try {
      const overlay = readFileSync(join(anchor, "docs", "operating-overlay.md"), "utf8").trim();
      if (overlay) {
        lines.push(
          "",
          "<!-- INCLUDED from docs/operating-overlay.md -- edit THAT file, then recompile (harness boot). -->",
          overlay,
        );
        overlayIncluded = true;
      }
    } catch {
      /* no overlay doc -- fine */
    }
  }

  const content = lines.join("\n") + "\n";
  return {
    target: "agents-md",
    path: "AGENTS.md",
    content,
    hash: sha256(content),
    provenance: {
      kernel: kernelVersion,
      from: [
        "kernel-contract", "identity", "governance", "routing", "evaluation.gates", "perimeter", "context.charters",
        ...(overlayIncluded ? ["docs/operating-overlay.md"] : []),
      ],
    },
  };
}

/**
 * Tier-table target: resolve the project's allowed tier aliases against the
 * kernel tier registry (docs/harness/11) into concrete (provider, model,
 * transport, role). A tier not in the registry is surfaced as unresolvable.
 */
export function emitTierTable(
  resolved: HarnessManifest,
  registry: Readonly<Record<string, TierEntry>>,
  kernelVersion: string,
): CompiledArtifact {
  const tiers = resolved.routing?.tiers ?? [];
  const resolvedTiers = tiers.filter((t) => registry[t]).map((t) => ({ alias: t, ...registry[t] }));
  const unresolvable = tiers.filter((t) => !registry[t]);
  const content =
    JSON.stringify({ _generated: "harness -- do not edit", kernel: kernelVersion, tiers: resolvedTiers, unresolvable }, null, 2) + "\n";
  return {
    target: "tier-table",
    path: ".harness/tiers.json",
    content,
    hash: sha256(content),
    provenance: { kernel: kernelVersion, from: ["routing.tiers", "kernel.tier-registry"] },
  };
}

/**
 * Tool-set target: the resolved MCP list + the allow/ask/deny/hidden decision
 * table (docs/harness/13), machine-readable for the runtime. hidden is kept
 * distinct from deny (invisible vs visible-but-blocked).
 */
export function emitToolSet(resolved: HarnessManifest, kernelVersion: string): CompiledArtifact {
  const p = resolved.tools?.permissions ?? {};
  const content =
    JSON.stringify(
      {
        _generated: "harness -- do not edit",
        kernel: kernelVersion,
        mcp: resolved.tools?.mcp ?? [],
        permissions: { allow: p.allow ?? [], ask: p.ask ?? [], deny: p.deny ?? [], hidden: p.hidden ?? [] },
      },
      null,
      2,
    ) + "\n";
  return {
    target: "tool-set",
    path: ".harness/tools.json",
    content,
    hash: sha256(content),
    provenance: { kernel: kernelVersion, from: ["tools.mcp", "tools.permissions"] },
  };
}

/**
 * Compile the resolved manifest to shadow artifacts (docs/harness/03 Section 7).
 * Emits each target whose declaring fields are present. The result is written to
 * shadow by the caller; the adopter (0.3) is the only thing that materializes
 * shadow -> live. More targets (context bundle, packs, eval config) are
 * follow-ons.
 */
export function compileTargets(
  resolved: HarnessManifest,
  kernelVersion: string,
  tierRegistry: Readonly<Record<string, TierEntry>>,
  anchor?: string,
): CompiledArtifact[] {
  const out: CompiledArtifact[] = [];
  out.push(emitAgentsMd(resolved, kernelVersion, anchor));
  if (resolved.routing?.tiers?.length) out.push(emitTierTable(resolved, tierRegistry, kernelVersion));
  if (resolved.tools) out.push(emitToolSet(resolved, kernelVersion));
  if (resolved.perimeter?.deploy) out.push(emitDeployScope(resolved, kernelVersion));
  return out;
}
