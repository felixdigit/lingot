# lingot

The standard library for AI agents. Intelligence blocks that make Cursor, Windsurf, and Claude Code measurably better at writing code.

## Quick Start

```bash
# Install a block
npx lingot add supabase-auth

# Detect your stack and see recommendations
npx lingot init

# Install multiple blocks
npx lingot add drizzle-orm stripe-billing tailwind-v4
```

## What Are Intelligence Blocks?

Each block contains 4 files of curated, token-optimized context:

- **knowledge.md** — Dense domain knowledge, mental models, architecture patterns
- **rules.xml** — ALWAYS/NEVER heuristic rules that prevent hallucinations
- **examples.yaml** — Few-shot input/output examples for common tasks
- **manifest.json** — Metadata, version, scope coverage

Load blocks into your AI agent's context to get measurably better output. Our Supabase Auth block improved LLM accuracy from 35.3% to 100% on domain-specific tasks.

## Commands

| Command | Description |
|---------|-------------|
| `lingot add <name>` | Install a block from the registry |
| `lingot init` | Scan package.json and suggest relevant blocks |
| `lingot list` | List installed blocks |
| `lingot inspect <name>` | Show block details and token counts |
| `lingot serve` | Start local MCP server for installed blocks |

## 40+ Blocks Available

Auth, frontend, backend, database, AI SDKs, payments, testing, DevOps, and more.

Browse all blocks at [lingot.sh](https://lingot.sh).

## MCP Integration

Start the local MCP server to expose installed blocks to any MCP-compatible agent:

```bash
lingot serve
```

This provides two tools:
- `search_packages` — Find relevant blocks by topic or domain
- `get_package_context` — Load block content into agent context

## License

MIT
