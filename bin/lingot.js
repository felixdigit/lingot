#!/usr/bin/env node

import { install } from '../lib/install.js';
import { init } from '../lib/init.js';
import { list } from '../lib/list.js';
import { serve } from '../lib/serve.js';
import { inspect } from '../lib/inspect.js';
import { PACKAGES_DIR } from '../lib/config.js';

const [,, command, ...args] = process.argv;

const HELP = `
lingot — The standard library for AI agents.

Usage:
  lingot add <name>          Install an intelligence block from the registry
  lingot init                Detect your stack and suggest relevant blocks
  lingot list                List installed blocks
  lingot inspect <name>      Show block details and token counts
  lingot serve               Start local MCP server for installed blocks
  lingot help                Show this help

Blocks are installed to: ${PACKAGES_DIR}

Examples:
  npx lingot add supabase-auth
  npx lingot init
  npx lingot add drizzle-orm stripe-billing tailwind-v4

Registry: https://lingot.sh
`;

async function main() {
  switch (command) {
    case 'add':
    case 'install':
    case 'i':
      if (!args[0]) {
        console.error('Usage: lingot add <block-name> [block-name...]');
        process.exit(1);
      }
      for (const name of args) {
        await install(name);
      }
      break;

    case 'init':
      await init();
      break;

    case 'list':
    case 'ls':
      await list();
      break;

    case 'inspect':
      if (!args[0]) {
        console.error('Usage: lingot inspect <block-name>');
        process.exit(1);
      }
      await inspect(args[0]);
      break;

    case 'serve':
      await serve();
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
