#!/usr/bin/env node

import { install } from '../lib/install.js';
import { init } from '../lib/init.js';
import { list } from '../lib/list.js';
import { serve } from '../lib/serve.js';
import { inspect } from '../lib/inspect.js';
import { validate } from '../lib/validate.js';
import { auth } from '../lib/auth.js';
import { login } from '../lib/login.js';
import { org } from '../lib/org.js';
import { runEval, runEvalAll } from '../lib/aii.js';
import { applyBudget, printBudgetSummary } from '../lib/budget.js';
import { mine } from '../lib/mine.js';
import { doctor } from '../lib/doctor.js';
import { compile } from '../lib/compile.js';
import { remove } from '../lib/remove.js';
import { update } from '../lib/update.js';
import { PACKAGES_DIR, REGISTRY_URL } from '../lib/config.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

const [,, command, ...rawArgs] = process.argv;

const HELP = `
lingot — The standard library for AI agents.

Usage:
  lingot add <name> [names...]   Install intelligence blocks from the registry
  lingot add @org/name           Install a private block from an org registry
  lingot add <names> --budget N  Install blocks with a token budget limit
  lingot auth <key>              Save and verify a license key for premium blocks
  lingot login                   Login to default registry (lingot.sh)
  lingot login --registry=<url>  Login to a private registry
  lingot org add @name <url>     Register an org's private registry URL
  lingot org remove @name        Remove an org registry mapping
  lingot org list                List registered org registries
  lingot init                    Detect your stack and suggest relevant blocks
  lingot list                    List installed blocks
  lingot inspect <name>          Show block details and token counts
  lingot validate <dir>          Validate an intelligence block directory
  lingot eval <name>             Run AII hallucination-delta evals for a block
  lingot eval-all                Run AII evals for all installed blocks with evals.yaml
  lingot mine <url>              Auto-mine an intelligence block from a documentation URL
  lingot remove <name> [names...] Remove installed blocks
  lingot update [name...]        Check for and install block updates
  lingot doctor [dir]            Lint blocks for context quality (Pink Elephant, dilution, collisions)
  lingot compile [dir]           Compile blocks into agent-ready format (Cursor .mdc or CLAUDE.md)
  lingot search <query>          Search the registry for blocks
  lingot serve                   Start local MCP server for installed blocks
  lingot version                 Show CLI version
  lingot help                    Show this help

Flags:
  --budget <N>                   Set token budget limit for add command
  --output <dir>                 Output directory for mine command
  --name <slug>                  Override block slug for mine command
  --registry <url>               Target registry for login command
  --key <api-key>                API key for login (skip interactive prompt)
  --target <cursor|claude>       Target format for compile (default: claude)
  --report                       Output machine-readable JSON from doctor
  --verbose                      Show detailed output (prompts, responses, reasons)

Blocks are installed to: ${PACKAGES_DIR}

Examples:
  npx lingot add supabase-auth
  npx lingot add @acme/api-gateway
  npx lingot init
  npx lingot add drizzle-orm stripe-billing tailwind-v4
  npx lingot add supabase-auth drizzle-orm zod --budget 15000
  npx lingot login --registry=https://lingot.acme.io
  npx lingot org add @acme https://lingot.acme.io
  npx lingot mine https://docs.example.com/api
  npx lingot mine https://docs.example.com/api --name my-block --output ./blocks
  npx lingot eval supabase-auth --verbose
  npx lingot eval ./blocks/supabase-auth
  npx lingot doctor
  npx lingot doctor ./packages --report
  npx lingot compile --target cursor
  npx lingot compile --target claude --output ./CLAUDE.md

Registry: https://lingot.sh
`;

/**
 * Parse args to separate block names from flags.
 * Supports: --budget <N>, --verbose
 * Returns block names (non-flag args) and parsed flag values.
 */
function parseAddArgs(args) {
  const blockNames = [];
  let budget = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--budget') {
      const val = args[i + 1];
      if (!val || isNaN(Number(val))) {
        console.error('Error: --budget requires a numeric value (token count)');
        console.error('Usage: lingot add <blocks...> --budget 15000');
        process.exit(1);
      }
      budget = Number(val);
      i++; // skip the value
    } else if (args[i].startsWith('--')) {
      // Ignore unknown flags silently (e.g. --verbose passed through)
      continue;
    } else {
      blockNames.push(args[i]);
    }
  }

  return { blockNames, budget };
}

async function main() {
  switch (command) {
    case 'add':
    case 'install':
    case 'i': {
      const { blockNames, budget } = parseAddArgs(rawArgs);

      if (blockNames.length === 0) {
        console.error('Usage: lingot add <block-name> [block-name...] [--budget N]');
        process.exit(1);
      }

      // Install all requested blocks
      for (const name of blockNames) {
        await install(name);
      }

      // Apply budget constraints if --budget was specified
      if (budget !== null) {
        const result = applyBudget(blockNames, budget);
        printBudgetSummary(budget, blockNames, result);
      }

      break;
    }

    case 'init':
      await init();
      break;

    case 'list':
    case 'ls':
      await list();
      break;

    case 'inspect':
      if (!rawArgs[0]) {
        console.error('Usage: lingot inspect <block-name>');
        process.exit(1);
      }
      await inspect(rawArgs[0]);
      break;

    case 'auth':
      await auth(rawArgs[0]);
      break;

    case 'login':
      await login(rawArgs);
      break;

    case 'org':
      await org(rawArgs);
      break;

    case 'validate':
      await validate(rawArgs[0]);
      break;

    case 'eval':
      if (!rawArgs[0]) {
        console.error('Usage: lingot eval <block-name> [--verbose]');
        process.exit(1);
      }
      await runEval(rawArgs.filter(a => !a.startsWith('--'))[0], rawArgs.includes('--verbose'));
      break;

    case 'eval-all':
      await runEvalAll(rawArgs.includes('--verbose'));
      break;

    case 'mine': {
      const mineArgs = rawArgs.filter(a => !a.startsWith('--'));
      if (!mineArgs[0]) {
        console.error('Usage: lingot mine <url> [--output <dir>] [--name <slug>]');
        process.exit(1);
      }
      // Extract --output and --name flag values
      const flagValue = (flag) => {
        const idx = rawArgs.indexOf(flag);
        return idx !== -1 && rawArgs[idx + 1] ? rawArgs[idx + 1] : undefined;
      };
      await mine(mineArgs[0], {
        output: flagValue('--output'),
        name: flagValue('--name'),
      });
      break;
    }

    case 'remove':
    case 'uninstall':
    case 'rm': {
      const removeNames = rawArgs.filter(a => !a.startsWith('--'));
      await remove(removeNames);
      break;
    }

    case 'update':
    case 'upgrade': {
      const updateNames = rawArgs.filter(a => !a.startsWith('--'));
      await update(updateNames.length > 0 ? updateNames : undefined);
      break;
    }

    case 'doctor':
    case 'lint':
      await doctor(rawArgs);
      break;

    case 'compile':
    case 'build':
      await compile(rawArgs);
      break;

    case 'search': {
      const query = rawArgs.filter(a => !a.startsWith('--')).join(' ');
      if (!query) {
        console.error('Usage: lingot search <query>');
        process.exit(1);
      }
      try {
        const res = await fetch(`${REGISTRY_URL}/search?q=${encodeURIComponent(query)}`);
        const { results } = await res.json();
        if (!results || results.length === 0) {
          console.log(`No blocks found for "${query}".`);
          break;
        }
        console.log(`\n  ${results.length} block${results.length === 1 ? '' : 's'} matching "${query}":\n`);
        for (const r of results) {
          const tokens = r.tokens_total ? ` (${r.tokens_total.toLocaleString()} tokens)` : '';
          console.log(`  \x1b[1m${r.slug}\x1b[0m @${r.version}${tokens}`);
          if (r.description) console.log(`  \x1b[2m${r.description}\x1b[0m`);
          console.log();
        }
      } catch (err) {
        console.error(`Search failed: ${err.message}`);
        process.exit(1);
      }
      break;
    }

    case 'serve':
      await serve();
      break;

    case 'version':
    case '--version':
    case '-v':
      console.log(`lingot v${PKG.version}`);
      break;

    case 'help':
    case '--help':
    case '-h':
    case undefined:
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
