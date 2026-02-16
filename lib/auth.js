import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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

export function getStoredKey() {
  const config = readConfig();
  return config.license_key || null;
}

export async function auth(key) {
  if (!key) {
    const stored = getStoredKey();
    if (stored) {
      console.log(`License key: ${stored.slice(0, 8)}...${stored.slice(-4)}`);
      console.log(`Config: ${CONFIG_PATH}`);
    } else {
      console.log('No license key configured.');
      console.log('');
      console.log('Usage: lingot auth <license-key>');
      console.log('');
      console.log('Get a key at https://lingot.sh/blueprint');
    }
    return;
  }

  // Verify key against registry
  console.log('Verifying license key...');
  try {
    const res = await fetch(`${REGISTRY_URL}/licenses/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error(`✗ Invalid key: ${data.error || 'verification failed'}`);
      process.exit(1);
    }

    const data = await res.json();
    const config = readConfig();
    config.license_key = key;
    writeConfig(config);

    console.log(`✓ License key verified and saved.`);
    if (data.tier) console.log(`  Tier: ${data.tier}`);
    console.log(`  Config: ${CONFIG_PATH}`);
    console.log('');
    console.log('You now have access to premium blocks.');
    console.log('  npx lingot add saas-blueprint');
  } catch (err) {
    console.error(`✗ Could not reach registry: ${err.message}`);
    process.exit(1);
  }
}
