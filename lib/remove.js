import { existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

export async function remove(names) {
  if (!names || names.length === 0) {
    console.error('Usage: lingot remove <block-name> [block-name...]');
    process.exit(1);
  }

  for (const name of names) {
    const blockDir = join(PACKAGES_DIR, name);

    if (!existsSync(blockDir)) {
      console.log(`  \x1b[33m${name}\x1b[0m — not installed, skipping`);
      continue;
    }

    // Read manifest for display info
    let version = '?';
    for (const mf of ['lingot.json', 'manifest.json']) {
      const mfPath = join(blockDir, mf);
      if (existsSync(mfPath)) {
        try {
          const manifest = JSON.parse(readFileSync(mfPath, 'utf-8'));
          version = manifest.version || '?';
        } catch {}
        break;
      }
    }

    rmSync(blockDir, { recursive: true, force: true });
    console.log(`  \x1b[32m✓\x1b[0m removed ${name}@${version}`);
  }
}
