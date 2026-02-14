import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

export async function list() {
  if (!existsSync(PACKAGES_DIR)) {
    console.log('No packages installed.');
    console.log(`Install path: ${PACKAGES_DIR}`);
    return;
  }

  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (dirs.length === 0) {
    console.log('No packages installed.');
    return;
  }

  console.log(`\nInstalled packages (${PACKAGES_DIR}):\n`);

  for (const dir of dirs) {
    const manifestPath = join(PACKAGES_DIR, dir.name, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const tokens = manifest.tokens?.total || '?';
    console.log(`  ${manifest.name}@${manifest.version}  (${tokens} tokens)`);
    console.log(`    ${manifest.description}`);
    console.log();
  }
}
