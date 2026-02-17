# Changelog

## 1.6.3

- `lingot compile` — **Dead Rule Elimination**: Strips rules.xml from declarative library blocks by default (knowledge carries 99.4% of signal). Use `--rules` to override. Behavioral domains (workflow, architecture, style, security, compliance) keep their rules.
- `lingot doctor` — **LINT-004 Instructional Bloat** replaces LINT-001 (Pink Elephant Tax). Flags blocks where rules exceed 50% of total tokens. Based on B-2 finding: rules yield <53% accuracy alone.
- **E-3 Latent Hijacker confirmed:** Co-loading overlapping-domain blocks (drizzle + supabase-auth) causes -13.3pp accuracy crash (p < 0.0001, N=1,440)
- **E-1 GPT-4o partial:** Knowledge context generalizes across model families (95.7% on GPT-4o)

## 1.6.2

- `lingot inspect <name>` now fetches from registry when block is not installed locally
- **supabase-auth v2.0.0** — multi-tenant RLS, admin roles, realtime caching, deprecated pattern migration (4,440 tokens)
- Mobile-responsive navigation with hamburger menu
- Custom 404 page
- **Research update:** B-2 experiment complete (N=100, 7,171 assertions) — knowledge carries 98%+ of the signal, rules add marginal noise regardless of polarity

## 1.6.1

- `lingot outdated` — check for blocks with newer registry versions (dry-run)

## 1.6.0

- `lingot diff <name>` — compare local vs registry version of a block
- **Bug fix:** `lingot add` now works correctly (was failing with 404 on manifest download)
- Fixed R2 URL for manifest.json in registry API

## 1.5.2

- `lingot doctor --min-score <N>` — configurable pass threshold for CI pipelines
- CI/CD example in README (GitHub Actions workflow)

## 1.5.1

- `lingot create <name>` — scaffold a new intelligence block with templates
- Templates pass `lingot validate` out of the box (15/15 checks)

## 1.5.0

- `lingot compile --target windsurf` — compile blocks into `.windsurfrules` format
- Windsurf generates a single monolithic rules file (project root)
- All three major AI editors now supported: Cursor, Claude Code, Windsurf

## 1.4.3

- `lingot list --json` — machine-readable JSON output for CI/scripting
- `lingot list` now shows total block count and token sum

## 1.4.2

- `lingot init` dependency map expanded to cover all 77 blocks
- Covers auth (6), frameworks (6), backend (4), database (6), frontend (8), and more

## 1.4.1

- `lingot stats` / `lingot info` — dashboard showing installed blocks, total tokens, disk usage, domains
- Helpful for understanding your context budget at a glance

## 1.4.0

- `lingot update [names...]` — check registry for newer block versions and re-install
- `lingot upgrade` alias

## 1.3.1

- `lingot remove <name>` — uninstall blocks (`uninstall`, `rm` aliases)
- Getting started docs page at lingot.sh/docs

## 1.3.0

- `lingot search <query>` — search the registry from the CLI
- `lingot --version` / `lingot version`
- Updated npm description with clinical trial data

## 1.2.1

- Fixed .npmignore — excluded trial data, scripts, research ops (205KB → 30KB)

## 1.2.0

- `lingot doctor [dir]` — context health scoring (0-100)
  - LINT-004: Instructional Bloat (rules-heavy blocks)
  - LINT-002: Attention Dilution (token overload)
  - LINT-003: Latent Collision (scope overlap)
  - `--report` flag for machine-readable JSON
- `lingot compile [dir]` — compile blocks into agent-ready formats
  - `--target cursor` generates .cursorrules files
  - `--target claude` generates CLAUDE.md
  - Semantic Lens ordering (knowledge → rules → examples)

## 1.1.0

- `lingot auth` — license key management for premium blocks
- `lingot login` — registry authentication
- `lingot org` — private registry management
- `lingot mine <url>` — auto-mine blocks from documentation URLs
- `lingot eval` / `lingot eval-all` — AII hallucination-delta testing
- `lingot validate` — block structure validation
- `lingot serve` — MCP server for installed blocks
- Budget optimizer with `--budget` flag
- Private registry support with `@org/block` syntax

## 1.0.0

- `lingot add <name>` — install blocks from the registry
- `lingot init` — detect stack and suggest blocks
- `lingot list` — list installed blocks
- `lingot inspect <name>` — show block details
- 77 intelligence blocks covering the modern JS/TS ecosystem
