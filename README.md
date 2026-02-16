# lingot

[![npm version](https://img.shields.io/npm/v/lingot.svg)](https://www.npmjs.com/package/lingot)
[![license](https://img.shields.io/npm/l/lingot.svg)](https://github.com/felixdigit/lingot/blob/main/LICENSE)

The context compiler for AI coding agents. Intelligence blocks that make Cursor, Windsurf, and Claude Code measurably better.

**Baseline pass rate without context: 52%. With a single Lingot block: 99.7%.**

That's from 6,400+ controlled assertions across 4 experiments. Same model, same prompts. The only variable was context. [Read the research →](https://lingot.sh/research)

## Quick Start

```bash
# Install a block
npx lingot add supabase-auth

# Detect your stack and see recommendations
npx lingot init

# Install multiple blocks
npx lingot add drizzle-orm stripe-billing tailwind-v4

# Score your project's context health
npx lingot doctor

# Compile blocks for your agent
npx lingot compile --target cursor    # .cursorrules
npx lingot compile --target windsurf  # .windsurfrules
npx lingot compile --target claude    # CLAUDE.md
```

## What Are Intelligence Blocks?

Each block contains 4 files of curated, token-optimized context:

| File | Purpose |
|------|---------|
| `knowledge.md` | Dense domain knowledge, mental models, current API patterns |
| `rules.xml` | Affirmative heuristic rules that prevent hallucinations |
| `examples.yaml` | Few-shot input/output examples for common tasks |
| `lingot.json` | Metadata, version, dependencies, scope coverage |

Load blocks into your AI agent's context to get measurably better output. Our Drizzle ORM block improved code accuracy from 52% to 99.7% across 5 eval scenarios.

## Commands

| Command | Description |
|---------|-------------|
| `lingot add <name>` | Install a block from the registry |
| `lingot remove <name>` | Remove installed blocks |
| `lingot update [name...]` | Check for and install block updates |
| `lingot init` | Scan package.json and suggest relevant blocks |
| `lingot list` | List installed blocks with token counts |
| `lingot inspect <name>` | Show block details, version, and scope |
| `lingot search <query>` | Search the registry |
| `lingot doctor` | Score context health 0-100, detect Pink Elephant Tax |
| `lingot compile` | Compile for Cursor, Claude Code, Windsurf |
| `lingot stats` | Show installed blocks summary and token usage |
| `lingot serve` | Start local MCP server for installed blocks |

## `lingot doctor`

Scores your project's context files on three clinical metrics:

- **LINT-001: Pink Elephant Tax** — Negative rules (NEVER, AVOID, DON'T) that inject deprecated tokens into the model's working memory. Our data shows each violation costs ~2.7% accuracy.
- **LINT-002: Attention Dilution** — Context blocks that exceed the signal-to-noise sweet spot (>8,000 tokens).
- **LINT-003: Latent Collision** — Blocks that will interfere when co-loaded due to overlapping scope domains.

```bash
npx lingot doctor                    # Score installed blocks
npx lingot doctor ./my-rules-dir     # Score a specific directory
npx lingot doctor --report           # Machine-readable JSON for CI
```

## `lingot compile`

Compiles installed blocks into the format your agent expects:

```bash
# Generate .cursorrules files (one per block)
npx lingot compile --target cursor

# Generate a single .windsurfrules file
npx lingot compile --target windsurf

# Generate a single CLAUDE.md with all blocks
npx lingot compile --target claude
```

The compiler uses **Semantic Lens ordering** — knowledge first (the map), then rules (the guardrails), then examples (the demonstrations). This matches our experimental findings: knowledge carries 95%+ of the signal.

## 77 Blocks Available

Auth, frontend, backend, database, AI SDKs, payments, testing, DevOps, and more.

Browse all blocks at [lingot.sh](https://lingot.sh).

### Popular blocks

```bash
npx lingot add drizzle-orm        # ORM with correct v3 patterns
npx lingot add supabase-auth      # Auth + RLS (v2.0, 4,440 tokens)
npx lingot add tailwind-v4        # CSS-first config, no tailwind.config.js
npx lingot add next-auth          # NextAuth.js v5 with App Router
npx lingot add stripe-billing     # Webhooks, subscriptions, checkout
npx lingot add prisma             # Schema design + Client extensions
npx lingot add zod                # Schema validation + type inference
```

## MCP Integration

Expose installed blocks to any MCP-compatible agent:

```bash
lingot serve
```

Provides two tools:
- `search_packages` — Find relevant blocks by topic
- `get_package_context` — Load block content into agent context

## The Research

We ran clinical trials to measure how context affects AI code generation:

| Context Level | Pass Rate | vs Baseline |
|---|---|---|
| No context | 52.0% | — |
| Rules only | 69.9% | +17.9pp |
| Knowledge only | **99.7%** | **+47.7pp** |
| Full block | 97.0% | +45.0pp |

Key findings:
- **Structured knowledge beats raw docs** — A 4,000-token block outperforms 40,000 tokens of copy-pasted documentation
- **Negative rules backfire** — "NEVER use X" makes X _more_ salient to the model (the Pink Elephant Tax)
- **Context has carrying capacity** — Some block combinations create asymmetric interference (Latent Hijacking)

Full methodology, data, and analysis: [lingot.sh/research](https://lingot.sh/research)

## CI/CD Integration

Gate your PRs on context health:

```yaml
# .github/workflows/context-lint.yml
name: Context Lint
on: [pull_request]
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx lingot doctor --min-score 80 --report
```

## Contributing

Want to create a block for your favorite library? See the [contribution guide](CONTRIBUTING.md).

```bash
npx lingot create my-block
# Edit the generated files, then validate:
npx lingot validate ./my-block
npx lingot doctor ./my-block
```

## License

MIT
