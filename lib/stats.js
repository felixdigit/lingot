import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

export async function stats() {
  if (!existsSync(PACKAGES_DIR)) {
    console.log('\n  No packages installed.\n');
    console.log(`  Install path: ${PACKAGES_DIR}`);
    console.log('  Run: npx lingot init\n');
    return;
  }

  const dirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  if (dirs.length === 0) {
    console.log('\n  No packages installed.\n');
    return;
  }

  let totalTokens = 0;
  let totalFiles = 0;
  let totalBytes = 0;
  const domains = new Set();
  const blocks = [];

  for (const dir of dirs) {
    let manifestPath = join(PACKAGES_DIR, dir.name, 'lingot.json');
    if (!existsSync(manifestPath)) {
      manifestPath = join(PACKAGES_DIR, dir.name, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const tokens = manifest.tokens?.total || 0;
    totalTokens += tokens;

    if (manifest.domain) domains.add(manifest.domain);

    // Count files and bytes
    const blockDir = join(PACKAGES_DIR, dir.name);
    const files = readdirSync(blockDir);
    totalFiles += files.length;
    for (const f of files) {
      try {
        totalBytes += statSync(join(blockDir, f)).size;
      } catch {}
    }

    blocks.push({
      name: manifest.name || dir.name,
      version: manifest.version || '?',
      tokens,
    });
  }

  // Sort by tokens descending
  blocks.sort((a, b) => b.tokens - a.tokens);

  const BOLD = '\x1b[1m';
  const DIM = '\x1b[2m';
  const GREEN = '\x1b[32m';
  const CYAN = '\x1b[36m';
  const RESET = '\x1b[0m';

  console.log();
  console.log(`  ${BOLD}lingot stats${RESET}`);
  console.log(`  ${'─'.repeat(40)}`);
  console.log(`  ${CYAN}Blocks installed:${RESET}  ${blocks.length}`);
  console.log(`  ${CYAN}Total tokens:${RESET}      ${totalTokens.toLocaleString()}`);
  console.log(`  ${CYAN}Total files:${RESET}       ${totalFiles}`);
  console.log(`  ${CYAN}Disk usage:${RESET}        ${(totalBytes / 1024).toFixed(1)} KB`);
  console.log(`  ${CYAN}Domains:${RESET}           ${[...domains].join(', ') || 'n/a'}`);
  console.log(`  ${CYAN}Install path:${RESET}      ${PACKAGES_DIR}`);
  console.log();

  // Top 5 by tokens
  console.log(`  ${DIM}Largest blocks:${RESET}`);
  for (const b of blocks.slice(0, 5)) {
    console.log(`    ${b.name}@${b.version}  ${GREEN}${b.tokens.toLocaleString()} tokens${RESET}`);
  }
  if (blocks.length > 5) {
    console.log(`    ${DIM}... and ${blocks.length - 5} more${RESET}`);
  }
  console.log();
}
