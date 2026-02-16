import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import { REGISTRY_URL } from './config.js';

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

function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/**
 * Parse login-specific flags from raw args.
 * Supports: --registry=<url>, --key=<api-key>, --registry <url>, --key <api-key>
 */
function parseLoginArgs(args) {
  let registry = null;
  let key = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith('--registry=')) {
      registry = arg.split('=').slice(1).join('=');
    } else if (arg === '--registry' && args[i + 1]) {
      registry = args[++i];
    } else if (arg.startsWith('--key=')) {
      key = arg.split('=').slice(1).join('=');
    } else if (arg === '--key' && args[i + 1]) {
      key = args[++i];
    }
  }

  return { registry, key };
}

/**
 * lingot login [--registry=<url>] [--key=<api-key>]
 *
 * Authenticates with a registry and stores credentials in ~/.lingot/config.json.
 * If no --registry is provided, defaults to the public Lingot registry.
 */
export async function login(args = []) {
  const { registry: registryFlag, key: keyFlag } = parseLoginArgs(args);

  // Determine the registry URL — default to the Lingot public registry base URL
  const registryUrl = registryFlag || 'https://lingot.sh';

  console.log(`Logging in to ${registryUrl}...`);
  console.log();

  // Collect email
  const email = await prompt('Email: ');
  if (!email) {
    console.error('Error: email is required.');
    process.exit(1);
  }

  // Collect API key — from flag or prompt
  let apiKey = keyFlag;
  if (!apiKey) {
    apiKey = await prompt('API key: ');
  }
  if (!apiKey) {
    console.error('Error: API key is required.');
    process.exit(1);
  }

  // Verify credentials against the registry
  try {
    const loginEndpoint = registryUrl === 'https://lingot.sh'
      ? `${REGISTRY_URL}/auth/login`
      : `${registryUrl.replace(/\/$/, '')}/api/v1/auth/login`;

    const res = await fetch(loginEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, api_key: apiKey }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(`Login failed: ${data.error || `HTTP ${res.status}`}`);
      process.exit(1);
    }

    const data = await res.json();

    // Store credentials
    const config = readConfig();
    if (!config.registries) config.registries = {};

    config.registries[registryUrl] = {
      email,
      api_key: apiKey,
      ...(data.token ? { token: data.token } : {}),
    };

    writeConfig(config);

    console.log(`Logged in to ${registryUrl} as ${email}`);
    if (data.orgs && data.orgs.length > 0) {
      console.log(`  Organizations: ${data.orgs.map(o => `@${o}`).join(', ')}`);
    }
    console.log(`  Config: ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`Could not reach registry: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Get stored credentials for a specific registry URL.
 */
export function getRegistryCredentials(registryUrl) {
  const config = readConfig();
  if (!config.registries) return null;
  return config.registries[registryUrl] || null;
}

/**
 * Get the registry URL mapped to a given org (e.g., '@acme').
 * Returns null if no mapping exists.
 */
export function getOrgRegistry(orgName) {
  const config = readConfig();
  if (!config.orgs) return null;
  return config.orgs[orgName] || null;
}
