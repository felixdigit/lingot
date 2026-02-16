import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

export async function list(args = []) {
  const jsonMode = args.includes('--json');

  if (!existsSync(PACKAGES_DIR)) {
    if (jsonMode) { console.log(JSON.stringify({ packages: [] })); return; }
    console.log('No packages installed.');
    console.log(`Install path: ${PACKAGES_DIR}`);
    return;
  }

  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (dirs.length === 0) {
    if (jsonMode) { console.log(JSON.stringify({ packages: [] })); return; }
    console.log('No packages installed.');
    return;
  }

  const packages = [];

  for (const dir of dirs) {
    let manifestPath = join(PACKAGES_DIR, dir.name, 'lingot.json');
    if (!existsSync(manifestPath)) {
      manifestPath = join(PACKAGES_DIR, dir.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    packages.push({
      name: manifest.name || dir.name,
      version: manifest.version || '?',
      tokens: manifest.tokens?.total || 0,
      description: manifest.description || '',
      domain: manifest.domain || '',
    });
  }

  if (jsonMode) {
    console.log(JSON.stringify({ packages }, null, 2));
    return;
  }

  console.log(`\nInstalled packages (${PACKAGES_DIR}):\n`);

  let totalTokens = 0;
  for (const pkg of packages) {
    totalTokens += pkg.tokens;
    console.log(`  ${pkg.name}@${pkg.version}  (${pkg.tokens.toLocaleString()} tokens)`);
    console.log(`    ${pkg.description}`);
    console.log();
  }

  console.log(`  ${packages.length} blocks, ${totalTokens.toLocaleString()} tokens total\n`);
}
