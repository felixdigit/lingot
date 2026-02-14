import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

function fmt(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export async function inspect(name) {
  const pkgDir = join(PACKAGES_DIR, name);
  const manifestPath = join(pkgDir, 'manifest.json');

  if (!existsSync(manifestPath)) {
    throw new Error(`Package not found: ${name}\nRun 'lingot list' to see installed packages.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  console.log(`\n${manifest.name}@${manifest.version}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`Description:  ${manifest.description}`);
  console.log(`Domain:       ${manifest.domain}`);
  console.log(`Category:     ${manifest.category}`);
  console.log(`Requires:     ${manifest.requires?.join(', ') || 'none'}`);
  console.log(`Keywords:     ${manifest.keywords?.join(', ')}`);
  console.log(`Author:       ${manifest.author}`);
  console.log(`License:      ${manifest.license}`);
  console.log();

  if (manifest.quality) {
    const q = manifest.quality;
    const compression = (q.source_tokens / manifest.tokens.total).toFixed(1);
    const coveragePct = Math.round((q.scope.covered_items / q.scope.total_items) * 100);

    console.log(`Quality:`);
    console.log(`  Compression:  ${compression}x (${fmt(q.source_tokens)} source tokens -> ${fmt(manifest.tokens.total)} block tokens)`);
    console.log(`  Coverage:     ${coveragePct}% of ${q.scope.type} (${q.scope.covered_items}/${q.scope.total_items} items)`);
    console.log(`  Scope:        ${q.scope.description}`);
    console.log(`  Verified:     ${q.verified} (${q.timestamp})`);
    console.log(`  Status:       ${q.maintenance}`);
    console.log();
  }

  console.log(`Tokens:`);
  console.log(`  knowledge:  ${fmt(manifest.tokens.knowledge)}`);
  console.log(`  rules:      ${fmt(manifest.tokens.rules)}`);
  console.log(`  examples:   ${fmt(manifest.tokens.examples)}`);
  console.log(`  total:      ${fmt(manifest.tokens.total)}`);
  console.log();
  console.log(`Sources:`);
  for (const src of manifest.sources || []) {
    console.log(`  ${src.title}: ${src.url}`);
  }
  console.log();
}
