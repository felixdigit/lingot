# Lingot

**The compiler and control plane for the Nexod studio harness.** One shared kernel, many projects: every
project is turned on, shaped, and switched off by editing one manifest, and every surface an agent touches
is compiled from that manifest against the kernel.

Package: `@nexod/lingot-policy`. This README is both the package overview (for a standalone reader) and the
operator's guide (how you boot a project and how skills flow across projects). The full design lives in
`../../docs/harness/`.

---

## What Lingot is (the one-paragraph version)

An **agent = a model + a harness**. The model has no loop, memory, tools, or knowledge of the world; the
harness is everything around it that turns a text-completion into an agent doing useful work. Lingot is the
factory that builds that harness for each project from a small declarative file, so the studio runs many
agents across many projects reliably, cheaply, and knowably -- without hand-wiring each one.

Three things, and how many of each:
- **The kernel** -- the shared, versioned defaults every project inherits (model routing, telemetry,
  safety floors, operating contract). **One**, lives here in `engine/lingot/`.
- **The spec** -- the blueprint that describes the whole harness. **One**, at `docs/harness/`. Not
  re-written per project.
- **The manifest** (`harness.json`) -- a project's order form ("I'm agency, here's what's special about me,
  build me against kernel v1.x"). **One per project**, at the project's root.

Compiled outputs (`AGENTS.md`, the tier table, the deploy ignore file) are generated per project and land
at that project. You never copy the spec into a project; you write a small manifest and the factory does
the rest.

## Status

- **Built (Phase 0 -- the control plane):** the `harness/v1` manifest + validator, the kernel-overlay
  compiler (deep-merge + non-overridable band + content-addressed, provenance-stamped artifacts), the emit
  targets (`AGENTS.md`, tier table, tool/permission set, deploy-scope), the adopter (materialize +
  connectivity verdict), the standing doctor, and the lockfile. CLI: `harness boot|adopt|doctor|lock`.
- **Spec, not yet built:** the context-bundle target (rewiring the block compiler), external model tiers
  (Z.ai/Grok/RunPod via a gateway), the evaluation and learning-loop layers, and manifest-driven skill
  distribution. See `docs/harness/99-sequencing.md` for the build order.
- **Coexistence:** `harness/v1` runs alongside the older `lingot/v0` manifests during migration; a v0
  project is flagged un-migrated, not broken.

## The model in 60 seconds

```
KERNEL (shared, versioned)  ─┐
                             ├─► COMPILE ─► ARTIFACTS ─► ADOPT ─► live surfaces the agent reads
MANIFEST (per project) ──────┘   (kernel     (content-   (materialize
 = kernel-pin + overlay          + overlay    addressed +  to .claude/,
                                  deep-merge)  provenance)  AGENTS.md, …)
```

The manifest is the single control plane. The compiler + adopter are what make it *control* rather than
documentation. `git diff` on a generated file is the circuit breaker -- generated files are marked
DO-NOT-EDIT and re-emitted from the manifest, never hand-edited.

## Booting a project (the protocol)

This is what happens for every project, whether you run it by hand or it fires on session start.

```
harness boot <project>
```

1. **Resolve.** Read the project's `harness.json` and its kernel pin. (A `harness.lock` records the exact
   resolved kernel version so a fresh checkout can't silently drift.)
2. **Compile.** Deep-merge the kernel defaults with the project's overlay (scalars override, lists join +
   dedup, objects blend; the project wins, except the kernel's locked floors). Render the artifacts.
3. **Adopt.** Materialize the artifacts to the paths the runtime reads -- idempotent, complete-or-rollback,
   every file DO-NOT-EDIT-stamped. (`--dry` computes the verdict without writing.)
4. **Verdict.** Emit the connectivity readout -- the "am I wired?" proof:
   ```
   harness: ON  project=agency  kernel=1.0.0-seed
     ok context: 1 block(s)
     ok tiers: 3 resolvable (reason,scoped,mechanical)
     ok perimeter: enforced (25 excludes)
     -- secrets: no secret refs        (-- = pending: check not yet plumbed)
     -- mcp: 5 server(s), probe not wired
     verdict: WIRED (2 pending: secrets,mcp)
   ```
   `WIRED` (all good), `DEGRADED` (something reachable-but-off, named), `BLOCKED` (a hard gap, named), or
   `OFF` (the manifest says `enabled: false`). It never fakes an "ok" for a check it hasn't actually run.
5. **Orient + work.** The agent now has its operating instructions, its model tiers, its tools, and its
   perimeter -- all from one file.

**Per-project difference is one field, not a new setup.** Booting agency vs. apsis vs. nexod-the-studio is
the same protocol; only the `harness.json` differs. Switching projects re-runs the boot for the new
manifest. Nothing reaches a session except through this boot -> adopt -> verdict chain -- that chain *is*
the on/off switch.

Companion verbs:
- `harness doctor <project>` -- the standing health check (are declarations connected, tiers real, secrets
  resolvable, deploy perimeter present). Runs at commit time; distinct from the per-session verdict.
- `harness lock <project>` -- pin the exact kernel version + a fingerprint of the manifest.

## Skills across projects

A **skill** is a reusable, invocable capability (a `SKILL.md` -- e.g. `boot`, `craft`). The cross-project
story is the same base+overlay model as everything else, at two levels:

- **Kernel skills (shared)** -- authored once in the kernel, inherited by *every* project. A skill fixed in
  the kernel appears everywhere on the next compile; no copy-paste.
- **Project skills (local)** -- declared by one project's manifest, live only in that project. Anything two
  projects need identically gets *promoted* into the kernel (the 95/5 rule: two consumers make it kernel
  code).
- **Scope** -- a skill materialized for a sub-area applies when work is under that area (the directory-
  scoped skills you see today, like agency's `boot`/`craft`, are this). The compile is cwd/scope-aware so a
  project's skills don't leak into a sibling.

**Today vs. planned (be precise):** right now skills are still Claude Code *native* -- they live in
`.claude/skills/` and load by Claude Code's own directory rules; the harness does not yet own their
distribution. The plan (`docs/harness/20-authoring-and-dx.md`) is to make skill distribution
manifest-driven: kernel skills compile into every project, project skills stay local, and the emitted
`AGENTS.md` is the portable operating-instructions artifact every AGENTS.md-aware tool reads. Until that
lands, treat kernel-shared skills as a convention; after it, they're compiled like any other artifact.

## CLI

```
harness boot   <dir|manifest> [--dry]   # resolve -> compile -> adopt -> verdict (the everyday entry)
harness adopt  <dir|manifest>           # materialize shadow -> live + verdict
harness doctor <dir|manifest>           # standing conformance verdict
harness lock   <dir|manifest>           # pin the kernel version -> harness.lock
```

Run via the studio root script (`pnpm harness ...`) or directly (`npx tsx engine/lingot/src/harness-cli.ts
...`). A project dir is expected to carry a `harness.json`.

The older `lingot` CLI (`pnpm lingot registry|map|doctor|compile`) still runs the v0 surfaces during
migration.

## Standalone on GitHub

The package is already publish-shaped: `private: false`, an npm `publishConfig`, and it depends only on
`yaml` (no studio-internal imports in the harness/v1 modules). To make it a standalone repo you would:
extract `engine/lingot/` to its own repository, move the kernel templates (`kernel/`) with it, and decide
how consumer repos pin it (an npm dependency, or a git submodule). The one coupling to unpick first is the
handful of shared types the harness modules import from `venture.ts` (the v0 manifest) -- small, and worth
doing when the v0 surface is retired. Until then it lives here as a workspace package.

## The full design

`docs/harness/` is the complete specification: `00-charter` + `01-architecture` (the spine), `02`-`05` (the
machinery), `10`-`21` (the twelve layers), `90`/`95`/`99` (cross-cutting, migration, build order), plus
`landscape.md` (build-vs-adopt) and `symptoms.md` (the real failures the harness must eradicate). The name
"Lingot" is the implementation; the spec describes the harness as a system.
