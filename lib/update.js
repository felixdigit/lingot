import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR, REGISTRY_URL } from './config.js';
import { install } from './install.js';

export async function update(names, opts = {}) {
  const dryRun = opts.dryRun || false;
  // If no names given, check all installed blocks
  if (!names || names.length === 0) {
    if (!existsSync(PACKAGES_DIR)) {
      console.log('No packages installed.');
      return;
    }
    names = readdirSync(PACKAGES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  }

  if (names.length === 0) {
    console.log('No packages installed.');
    return;
  }

  const verb = dryRun ? 'outdated' : 'updates';
  console.log(`\n  Checking ${names.length} block${names.length === 1 ? '' : 's'} for ${verb}...\n`);

  let updated = 0;
  let upToDate = 0;
  let errors = 0;

  for (const name of names) {
    // Read local version
    const blockDir = join(PACKAGES_DIR, name);
    let localVersion = null;
    for (const mf of ['lingot.json', 'manifest.json']) {
      const mfPath = join(blockDir, mf);
      if (existsSync(mfPath)) {
        try {
          const manifest = JSON.parse(readFileSync(mfPath, 'utf-8'));
          localVersion = manifest.version;
        } catch {}
        break;
      }
    }

    if (!localVersion) {
      console.log(`  \x1b[33m${name}\x1b[0m — not installed locally, skipping`);
      errors++;
      continue;
    }

    // Check registry version
    try {
      const res = await fetch(`${REGISTRY_URL}/packages/${name}`);
      if (!res.ok) {
        console.log(`  \x1b[33m${name}\x1b[0m — not found in registry`);
        errors++;
        continue;
      }
      const data = await res.json();
      const remoteVersion = data.version || data.manifest?.version;

      if (!remoteVersion) {
        console.log(`  \x1b[33m${name}\x1b[0m — registry returned no version`);
        errors++;
        continue;
      }

      if (remoteVersion === localVersion) {
        console.log(`  \x1b[2m${name}@${localVersion}\x1b[0m — up to date`);
        upToDate++;
      } else {
        if (dryRun) {
          console.log(`  \x1b[36m${name}\x1b[0m ${localVersion} → \x1b[32m${remoteVersion}\x1b[0m`);
        } else {
          console.log(`  \x1b[36m${name}\x1b[0m ${localVersion} → \x1b[32m${remoteVersion}\x1b[0m — updating...`);
          await install(name);
        }
        updated++;
      }
    } catch (err) {
      console.log(`  \x1b[31m${name}\x1b[0m — error: ${err.message}`);
      errors++;
    }
  }

  console.log();
  if (updated > 0) console.log(`  \x1b[32m${updated} ${dryRun ? 'outdated' : 'updated'}\x1b[0m`);
  if (upToDate > 0) console.log(`  \x1b[2m${upToDate} up to date\x1b[0m`);
  if (errors > 0) console.log(`  \x1b[33m${errors} skipped\x1b[0m`);
  console.log();
}
