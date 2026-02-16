import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR, REGISTRY_URL } from './config.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

const BLOCK_FILES = ['knowledge.md', 'rules.xml', 'examples.yaml', 'lingot.json'];
const FILE_KEY_MAP = { 'knowledge.md': 'knowledge', 'rules.xml': 'rules', 'examples.yaml': 'examples', 'lingot.json': 'manifest' };

export async function diff(name) {
  if (!name) {
    console.error('Usage: lingot diff <block-name>');
    process.exit(1);
  }

  const localDir = join(PACKAGES_DIR, name);
  if (!existsSync(localDir)) {
    console.error(`Block not installed: ${name}`);
    console.error(`Run: lingot add ${name}`);
    process.exit(1);
  }

  // Get remote metadata
  let remoteMeta;
  try {
    const res = await fetch(`${REGISTRY_URL}/packages/${name}`);
    if (!res.ok) throw new Error(`${res.status}`);
    remoteMeta = await res.json();
  } catch {
    console.error(`Could not fetch ${name} from registry.`);
    process.exit(1);
  }

  const remoteFiles = remoteMeta.files || {};

  // Read local manifest
  let localVersion = '?';
  const manifestPath = join(localDir, 'lingot.json');
  if (existsSync(manifestPath)) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      localVersion = m.version || '?';
    } catch {}
  }

  console.log();
  console.log(`${BOLD}lingot diff${RESET} ${CYAN}${name}${RESET}`);
  console.log();
  console.log(`  Local:  v${localVersion}`);
  console.log(`  Remote: v${remoteMeta.version}`);
  console.log();

  if (localVersion === remoteMeta.version) {
    console.log(`  ${DIM}Same version. Checking file contents...${RESET}`);
    console.log();
  }

  let diffs = 0;

  for (const file of BLOCK_FILES) {
    const localPath = join(localDir, file);
    const localContent = existsSync(localPath) ? readFileSync(localPath, 'utf-8') : null;

    let remoteContent = null;
    const fileKey = FILE_KEY_MAP[file];
    const remoteUrl = remoteFiles[fileKey];
    if (remoteUrl) {
      try {
        const url = remoteUrl.endsWith('/') ? remoteUrl + file : remoteUrl;
        const res = await fetch(url);
        if (res.ok) remoteContent = await res.text();
      } catch {}
    }

    if (localContent === null && remoteContent === null) continue;
    if (localContent === null) {
      console.log(`  ${RED}+ ${file}${RESET} ${DIM}(remote only)${RESET}`);
      diffs++;
      continue;
    }
    if (remoteContent === null) {
      console.log(`  ${GREEN}- ${file}${RESET} ${DIM}(local only)${RESET}`);
      diffs++;
      continue;
    }

    if (localContent.trim() === remoteContent.trim()) {
      console.log(`  ${DIM}= ${file}${RESET}`);
    } else {
      const localTokens = Math.ceil(localContent.length / 4);
      const remoteTokens = Math.ceil(remoteContent.length / 4);
      const delta = remoteTokens - localTokens;
      const sign = delta > 0 ? '+' : '';
      console.log(`  ${CYAN}~ ${file}${RESET} (${sign}${delta} tokens)`);
      diffs++;
    }
  }

  console.log();
  if (diffs === 0) {
    console.log(`  ${GREEN}Up to date — no differences.${RESET}`);
  } else {
    console.log(`  ${diffs} file${diffs !== 1 ? 's' : ''} differ. Run ${CYAN}lingot update ${name}${RESET} to sync.`);
  }
  console.log();
}
