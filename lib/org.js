import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_DIR = join(homedir(), '.lingot');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

function readConfig() {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(config) {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

/**
 * lingot org add @<name> <registry-url>
 * lingot org remove @<name>
 * lingot org list
 *
 * Manages org-to-registry mappings stored in ~/.lingot/config.json.
 */
export async function org(args = []) {
  const subcommand = args[0];

  switch (subcommand) {
    case 'add': {
      const orgName = args[1];
      const registryUrl = args[2];

      if (!orgName || !registryUrl) {
        console.error('Usage: lingot org add @<name> <registry-url>');
        console.error('');
        console.error('Example: lingot org add @acme https://lingot.acme.io');
        process.exit(1);
      }

      if (!orgName.startsWith('@')) {
        console.error(`Error: org name must start with @. Got: ${orgName}`);
        process.exit(1);
      }

      const config = readConfig();
      if (!config.orgs) config.orgs = {};

      config.orgs[orgName] = registryUrl.replace(/\/$/, '');
      writeConfig(config);

      console.log(`Registered org ${orgName} -> ${registryUrl}`);
      console.log(`  Config: ${CONFIG_PATH}`);
      console.log('');
      console.log(`You can now install private blocks:`);
      console.log(`  lingot add ${orgName}/my-block`);
      break;
    }

    case 'remove':
    case 'rm': {
      const orgName = args[1];

      if (!orgName) {
        console.error('Usage: lingot org remove @<name>');
        process.exit(1);
      }

      const config = readConfig();
      if (!config.orgs || !config.orgs[orgName]) {
        console.error(`Org not found: ${orgName}`);
        process.exit(1);
      }

      delete config.orgs[orgName];
      writeConfig(config);

      console.log(`Removed org ${orgName}`);
      break;
    }

    case 'list':
    case 'ls':
    case undefined: {
      const config = readConfig();
      const orgs = config.orgs || {};
      const entries = Object.entries(orgs);

      if (entries.length === 0) {
        console.log('No organizations registered.');
        console.log('');
        console.log('Add one with: lingot org add @<name> <registry-url>');
        return;
      }

      console.log('Registered organizations:');
      console.log('');
      for (const [name, url] of entries) {
        console.log(`  ${name} -> ${url}`);
      }
      break;
    }

    default:
      console.error(`Unknown org subcommand: ${subcommand}`);
      console.error('');
      console.error('Usage:');
      console.error('  lingot org add @<name> <registry-url>');
      console.error('  lingot org remove @<name>');
      console.error('  lingot org list');
      process.exit(1);
  }
}
