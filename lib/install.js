import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { PACKAGES_DIR, REGISTRY_URL } from './config.js';
import { getStoredKey } from './auth.js';
import { getOrgRegistry, getRegistryCredentials } from './login.js';
import { getProjectDependencies, checkCompatibility } from './resolve.js';

const PREMIUM_SLUGS = new Set(['saas-blueprint']);

function computeIntegrity(filePath) {
  const content = readFileSync(filePath);
  const hash = createHash('sha256').update(content).digest('hex');
  return `sha256-${hash}`;
}

function updateLockfile(manifest) {
  const lockPath = join(process.cwd(), 'aipkg.lock');
  let lock = { lockfileVersion: 1, packages: {} };

  if (existsSync(lockPath)) {
    lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  }

  lock.packages[manifest.name] = {
    version: manifest.version,
    integrity: computeIntegrity(join(PACKAGES_DIR, manifest.name, 'knowledge.md')),
    tokens: manifest.tokens?.total || 0,
    requires: manifest.requires || [],
  };

  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  return lockPath;
}

/**
 * Read the lockfile and return the set of currently installed block names.
 */
function getInstalledBlocks() {
  const lockPath = join(process.cwd(), 'aipkg.lock');
  if (!existsSync(lockPath)) return new Set();
  try {
    const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
    return new Set(Object.keys(lock.packages || {}));
  } catch {
    return new Set();
  }
}

/**
 * After installing a block, check its lingot.json for relationship fields
 * (requires, enhances, conflicts) and print actionable messages.
 */
function printRelationshipHints(manifest) {
  const installed = getInstalledBlocks();
  const name = manifest.name;

  // Hard dependencies — requires
  const requires = manifest.requires || [];
  if (requires.length > 0) {
    const missing = requires.filter(dep => !installed.has(dep));
    if (missing.length > 0) {
      console.log();
      console.log(`  ${name} requires: ${missing.join(', ')}`);
      console.log(`  Run: lingot add ${missing.join(' ')}`);
    }
  }

  // Soft recommendations — enhances
  const enhances = manifest.enhances || [];
  if (enhances.length > 0) {
    const notInstalled = enhances.filter(dep => !installed.has(dep));
    if (notInstalled.length > 0) {
      console.log();
      console.log(`  Tip: ${name} works better with: ${notInstalled.join(', ')}`);
    }
  }

  // Conflicts — warn about contradictory blocks
  const conflicts = manifest.conflicts || [];
  if (conflicts.length > 0) {
    const conflicting = conflicts.filter(dep => installed.has(dep));
    if (conflicting.length > 0) {
      console.log();
      for (const c of conflicting) {
        console.log(`  Warning: ${name} conflicts with ${c}. Loading both may cause contradictory rules.`);
      }
    }
  }
}

/**
 * Run semver compatibility checks against the project's dependencies
 * and print any warnings.
 */
function printCompatibilityWarnings(manifest) {
  const projectDeps = getProjectDependencies();
  if (Object.keys(projectDeps).length === 0) return;

  const warnings = checkCompatibility(manifest, projectDeps);
  for (const warning of warnings) {
    console.log(`  ${warning}`);
  }
}

function isLocalPath(arg) {
  return arg.startsWith('.') || arg.startsWith('/') || arg.startsWith('~');
}

async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  return res.text();
}

async function installRemote(packageName) {
  // Check if premium block requires a license key
  if (PREMIUM_SLUGS.has(packageName)) {
    const key = getStoredKey();
    if (!key) {
      console.error(`✗ ${packageName} is a premium block.`);
      console.error('');
      console.error('  Get it at https://lingot.sh/blueprint');
      console.error('  Then run: lingot auth <your-license-key>');
      process.exit(1);
    }

    // Verify key is still valid
    try {
      const verifyRes = await fetch(`${REGISTRY_URL}/licenses/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      if (!verifyRes.ok) {
        console.error('✗ License key is invalid or expired.');
        console.error('  Get a new key at https://lingot.sh/blueprint');
        process.exit(1);
      }
    } catch {
      console.error('✗ Could not verify license. Check your internet connection.');
      process.exit(1);
    }
  }

  // Fetch metadata from registry
  console.log(`Resolving ${packageName}...`);
  const metaRes = await fetch(`${REGISTRY_URL}/packages/${packageName}`);
  if (!metaRes.ok) {
    throw new Error(`Package not found: ${packageName}`);
  }
  const meta = await metaRes.json();

  const destDir = join(PACKAGES_DIR, packageName);
  mkdirSync(destDir, { recursive: true });

  // Download all 4 files in parallel
  console.log(`Downloading ${meta.name}@${meta.version}...`);
  const files = ['manifest', 'knowledge', 'rules', 'examples'];
  const filenames = {
    manifest: 'lingot.json',
    knowledge: 'knowledge.md',
    rules: 'rules.xml',
    examples: 'examples.yaml',
  };

  const downloads = await Promise.all(
    files.map(async (key) => {
      const content = await fetchFile(meta.files[key]);
      return { key, content };
    })
  );

  for (const { key, content } of downloads) {
    writeFileSync(join(destDir, filenames[key]), content);
  }

  const manifest = JSON.parse(readFileSync(join(destDir, 'lingot.json'), 'utf-8'));
  const lockPath = updateLockfile(manifest);

  console.log(`✓ Installed ${manifest.name}@${manifest.version} (${manifest.tokens.total} tokens)`);
  console.log(`  → ${destDir}`);
  console.log(`  → ${lockPath}`);

  // v1.1: semver compatibility check
  printCompatibilityWarnings(manifest);

  // v1.1: relationship hints (requires, enhances, conflicts)
  printRelationshipHints(manifest);
}

async function installLocal(sourcePath) {
  // Try lingot.json first, fall back to legacy manifest.json
  let manifestPath = join(sourcePath, 'lingot.json');
  if (!existsSync(manifestPath)) {
    manifestPath = join(sourcePath, 'manifest.json');
    if (!existsSync(manifestPath)) {
      throw new Error(`No lingot.json found in ${sourcePath}`);
    }
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  const required = ['knowledge.md', 'rules.xml', 'examples.yaml'];
  for (const file of required) {
    if (!existsSync(join(sourcePath, file))) {
      throw new Error(`Missing required file: ${file}`);
    }
  }

  const destDir = join(PACKAGES_DIR, manifest.name);
  mkdirSync(destDir, { recursive: true });
  cpSync(sourcePath, destDir, { recursive: true });

  const lockPath = updateLockfile(manifest);

  console.log(`✓ Installed ${manifest.name}@${manifest.version} (${manifest.tokens.total} tokens)`);
  console.log(`  → ${destDir}`);
  console.log(`  → ${lockPath}`);

  // v1.1: semver compatibility check
  printCompatibilityWarnings(manifest);

  // v1.1: relationship hints (requires, enhances, conflicts)
  printRelationshipHints(manifest);
}

/**
 * Parse an @org/package-name string into { orgName, packageSlug }.
 * Returns null if the arg is not org-scoped.
 */
function parseOrgPackage(arg) {
  if (!arg.startsWith('@')) return null;
  const slashIdx = arg.indexOf('/');
  if (slashIdx === -1) return null;
  return {
    orgName: arg.slice(0, slashIdx),    // '@acme'
    packageSlug: arg.slice(slashIdx + 1), // 'api-gateway'
  };
}

/**
 * Install a block from a private org registry.
 * Routes @acme/my-block to the registry mapped to @acme in ~/.lingot/config.json.
 */
async function installOrgPackage(orgName, packageSlug) {
  const registryUrl = getOrgRegistry(orgName);
  if (!registryUrl) {
    console.error(`No registry configured for ${orgName}.`);
    console.error('');
    console.error(`Register it with: lingot org add ${orgName} <registry-url>`);
    process.exit(1);
  }

  // Get credentials for this registry
  const creds = getRegistryCredentials(registryUrl);
  if (!creds) {
    console.error(`Not logged in to ${registryUrl}.`);
    console.error('');
    console.error(`Run: lingot login --registry=${registryUrl}`);
    process.exit(1);
  }

  const orgSlug = orgName.replace('@', '');
  const fullName = `${orgName}/${packageSlug}`;

  // Fetch package metadata from the org registry
  console.log(`Resolving ${fullName} from ${registryUrl}...`);
  const headers = {
    'Content-Type': 'application/json',
  };
  if (creds.token) {
    headers['Authorization'] = `Bearer ${creds.token}`;
  } else if (creds.api_key) {
    headers['x-api-key'] = creds.api_key;
  }

  const apiBase = `${registryUrl.replace(/\/$/, '')}/api/v1`;
  const metaRes = await fetch(`${apiBase}/org/${orgSlug}/packages/${packageSlug}`, {
    headers,
  });

  if (!metaRes.ok) {
    if (metaRes.status === 401 || metaRes.status === 403) {
      console.error(`Access denied to ${fullName}. Check your credentials.`);
      console.error(`Run: lingot login --registry=${registryUrl}`);
    } else if (metaRes.status === 404) {
      console.error(`Package not found: ${fullName}`);
    } else {
      console.error(`Failed to resolve ${fullName}: HTTP ${metaRes.status}`);
    }
    process.exit(1);
  }

  const meta = await metaRes.json();

  // Use a namespaced directory: ~/.lingot/packages/@acme/api-gateway
  const destDir = join(PACKAGES_DIR, orgName, packageSlug);
  mkdirSync(destDir, { recursive: true });

  // Download all files
  console.log(`Downloading ${meta.name || fullName}@${meta.version}...`);
  const files = ['manifest', 'knowledge', 'rules', 'examples'];
  const filenames = {
    manifest: 'lingot.json',
    knowledge: 'knowledge.md',
    rules: 'rules.xml',
    examples: 'examples.yaml',
  };

  const downloads = await Promise.all(
    files.map(async (key) => {
      if (!meta.files || !meta.files[key]) return null;
      const content = await fetchFile(meta.files[key]);
      return { key, content };
    })
  );

  for (const dl of downloads) {
    if (dl) {
      writeFileSync(join(destDir, filenames[dl.key]), dl.content);
    }
  }

  const manifestPath = join(destDir, 'lingot.json');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const lockPath = updateLockfile(manifest);

    console.log(`Installed ${fullName}@${manifest.version} (${manifest.tokens?.total || 0} tokens)`);
    console.log(`  -> ${destDir}`);
    console.log(`  -> ${lockPath}`);

    printCompatibilityWarnings(manifest);
    printRelationshipHints(manifest);
  } else {
    console.log(`Installed ${fullName} -> ${destDir}`);
  }
}

export async function install(arg) {
  const orgPkg = parseOrgPackage(arg);
  if (orgPkg) {
    await installOrgPackage(orgPkg.orgName, orgPkg.packageSlug);
  } else if (isLocalPath(arg)) {
    await installLocal(arg);
  } else {
    await installRemote(arg);
  }
}
