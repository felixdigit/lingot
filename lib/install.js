import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { PACKAGES_DIR, REGISTRY_URL } from './config.js';

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

function isLocalPath(arg) {
  return arg.startsWith('.') || arg.startsWith('/') || arg.startsWith('~');
}

async function fetchFile(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url}: ${res.status}`);
  return res.text();
}

async function installRemote(packageName) {
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
    manifest: 'manifest.json',
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

  const manifest = JSON.parse(readFileSync(join(destDir, 'manifest.json'), 'utf-8'));
  const lockPath = updateLockfile(manifest);

  console.log(`✓ Installed ${manifest.name}@${manifest.version} (${manifest.tokens.total} tokens)`);
  console.log(`  → ${destDir}`);
  console.log(`  → ${lockPath}`);
}

async function installLocal(sourcePath) {
  const manifestPath = join(sourcePath, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No manifest.json found in ${sourcePath}`);
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
}

export async function install(arg) {
  if (isLocalPath(arg)) {
    await installLocal(arg);
  } else {
    await installRemote(arg);
  }
}
