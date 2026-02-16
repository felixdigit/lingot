# Changelog

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
  - LINT-001: Pink Elephant Tax (negative rules)
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
