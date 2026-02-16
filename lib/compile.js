import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { PACKAGES_DIR } from './config.js';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

// Semantic Lens ordering: knowledge (grounding) → rules (invariants) → examples (exemplars)
const SECTION_ORDER = ['knowledge', 'rules', 'examples'];
const SECTION_FILES = { knowledge: 'knowledge.md', rules: 'rules.xml', examples: 'examples.yaml' };

function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

function readBlock(blockDir, name) {
  const files = {};

  for (const [key, filename] of Object.entries(SECTION_FILES)) {
    const path = join(blockDir, filename);
    if (existsSync(path)) {
      files[key] = readFileSync(path, 'utf-8');
    }
  }

  if (Object.keys(files).length === 0) return null;

  let manifest = null;
  for (const mf of ['lingot.json', 'manifest.json']) {
    const mp = join(blockDir, mf);
    if (existsSync(mp)) {
      try { manifest = JSON.parse(readFileSync(mp, 'utf-8')); } catch {}
      break;
    }
  }

  return { name, dir: blockDir, files, manifest };
}

function loadBlocks(dir) {
  // Check if dir itself is a block
  if (existsSync(join(dir, 'knowledge.md')) || existsSync(join(dir, 'rules.xml'))) {
    const block = readBlock(dir, dir.split('/').pop());
    return block ? [block] : [];
  }

  const blocks = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;

    const block = readBlock(join(dir, entry.name), entry.name);
    if (block) blocks.push(block);
  }

  return blocks;
}

/**
 * Quick toxic word count in <rule> tags for polarity warnings.
 */
function countToxicWords(rulesXml) {
  const ruleRegex = /<rule\s+id="[^"]+">([\s\S]*?)<\/rule>/g;
  let count = 0;
  let match;
  while ((match = ruleRegex.exec(rulesXml)) !== null) {
    const hits = match[1].match(/\b(NEVER|AVOID|DO\s+NOT|DON'?T|MUST\s+NOT|SHALL\s+NOT)\b/gi);
    if (hits) count += hits.length;
  }
  return count;
}

/**
 * Compile to Cursor .mdc format — one file per block with YAML frontmatter.
 */
function compileCursor(blocks, outputDir) {
  mkdirSync(outputDir, { recursive: true });

  let totalTokens = 0;
  const files = [];

  for (const block of blocks) {
    const parts = [];
    for (const section of SECTION_ORDER) {
      if (block.files[section]) parts.push(block.files[section]);
    }

    const body = parts.join('\n\n');
    const tokens = estimateTokens(body);
    totalTokens += tokens;

    const description = block.manifest?.description || `${block.name} intelligence block`;
    const globs = block.manifest?.targetDependencies?.cursor?.globs || [];

    let mdc = `---\ndescription: ${description}\n`;
    if (globs.length > 0) {
      mdc += `globs: ${globs.join(', ')}\n`;
    }
    mdc += `alwaysApply: ${globs.length === 0 ? 'true' : 'false'}\n`;
    mdc += `---\n\n`;
    mdc += body;

    const filename = `${block.name}.mdc`;
    writeFileSync(join(outputDir, filename), mdc);
    files.push({ name: filename, tokens });
  }

  return { files, totalTokens };
}

/**
 * Compile to Windsurf .windsurfrules — single monolithic rules file.
 * Windsurf reads a single .windsurfrules file from the project root.
 */
function compileWindsurf(blocks, outputPath) {
  const parts = [];

  parts.push(`# Project Intelligence Context`);
  parts.push(`# Compiled by lingot compile --target windsurf at ${new Date().toISOString()}`);
  parts.push(`# ${blocks.length} block${blocks.length !== 1 ? 's' : ''} loaded\n`);

  for (const block of blocks) {
    parts.push(`## ${block.name}`);
    if (block.manifest?.description) {
      parts.push(`# ${block.manifest.description}`);
    }
    parts.push('');

    for (const section of SECTION_ORDER) {
      if (block.files[section]) {
        parts.push(block.files[section]);
        parts.push('');
      }
    }
  }

  const output = parts.join('\n');
  const dir = resolve(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, output);

  return { totalTokens: estimateTokens(output) };
}

/**
 * Compile to monolithic CLAUDE.md — XML-wrapped sections per block.
 */
function compileClaude(blocks, outputPath) {
  const parts = [];

  parts.push(`# Project Intelligence Context`);
  parts.push(`<!-- Compiled by lingot compile at ${new Date().toISOString()} -->`);
  parts.push(`<!-- ${blocks.length} block${blocks.length !== 1 ? 's' : ''} loaded -->\n`);

  for (const block of blocks) {
    parts.push(`## ${block.name}`);
    if (block.manifest?.description) {
      parts.push(`<!-- ${block.manifest.description} -->`);
    }
    parts.push('');

    for (const section of SECTION_ORDER) {
      if (block.files[section]) {
        parts.push(`<${section} block="${block.name}">`);
        parts.push(block.files[section]);
        parts.push(`</${section}>`);
        parts.push('');
      }
    }
  }

  const output = parts.join('\n');
  const dir = resolve(outputPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(outputPath, output);

  return { totalTokens: estimateTokens(output) };
}

function parseArgs(args) {
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      flags.target = args[++i];
    } else if (args[i] === '--output' && args[i + 1]) {
      flags.output = args[++i];
    } else if (args[i] === '--budget' && args[i + 1]) {
      flags.budget = Number(args[++i]);
    } else if (!args[i].startsWith('--')) {
      positional.push(args[i]);
    }
  }

  return { flags, positional };
}

export async function compile(args = []) {
  const { flags, positional } = parseArgs(args);

  const target = flags.target || 'claude';
  const sourceDir = positional[0] ? resolve(positional[0]) : PACKAGES_DIR;

  const validTargets = ['cursor', 'claude', 'claude-code', 'windsurf'];
  if (!validTargets.includes(target)) {
    console.error(`Unknown target: ${target}`);
    console.error(`Valid targets: ${validTargets.join(', ')}`);
    process.exit(1);
  }

  const blocks = loadBlocks(sourceDir);

  if (blocks.length === 0) {
    console.error('No blocks found to compile.');
    console.error(`Scanned: ${sourceDir}`);
    process.exit(1);
  }

  // Polarity warnings
  let toxicTotal = 0;
  for (const block of blocks) {
    if (block.files.rules) {
      const count = countToxicWords(block.files.rules);
      if (count > 0) {
        console.log(`${YELLOW}Warning:${RESET} ${block.name} has ${count} toxic word${count > 1 ? 's' : ''} in rules \u2014 run ${CYAN}lingot doctor${RESET} to fix`);
        toxicTotal += count;
      }
    }
  }
  if (toxicTotal > 0) console.log();

  const SEP = '\u2500'.repeat(60);

  console.log(`${BOLD}lingot compile${RESET}`);
  console.log(SEP);
  console.log(`${DIM}Source:  ${sourceDir}${RESET}`);
  console.log(`${DIM}Target:  ${target}${RESET}`);
  console.log(`${DIM}Blocks:  ${blocks.length}${RESET}`);
  console.log();

  if (target === 'cursor') {
    const outDir = flags.output ? resolve(flags.output) : join(process.cwd(), '.cursor', 'rules');
    const result = compileCursor(blocks, outDir);

    for (const f of result.files) {
      console.log(`  ${GREEN}\u2713${RESET} ${f.name} (${f.tokens.toLocaleString()} tokens)`);
    }

    console.log();
    console.log(SEP);
    console.log(`  ${result.files.length} files written to ${outDir}`);
    console.log(`  Total: ${result.totalTokens.toLocaleString()} tokens`);
  } else if (target === 'windsurf') {
    const outPath = flags.output ? resolve(flags.output) : join(process.cwd(), '.windsurfrules');
    const result = compileWindsurf(blocks, outPath);

    for (const block of blocks) {
      const tokens = Object.values(block.files).reduce((sum, c) => sum + estimateTokens(c), 0);
      console.log(`  ${GREEN}\u2713${RESET} ${block.name} (${tokens.toLocaleString()} tokens)`);
    }

    console.log();
    console.log(SEP);
    console.log(`  Written to ${outPath}`);
    console.log(`  Total: ${result.totalTokens.toLocaleString()} tokens`);
  } else {
    const outPath = flags.output ? resolve(flags.output) : join(process.cwd(), 'CLAUDE.md');
    const result = compileClaude(blocks, outPath);

    for (const block of blocks) {
      const tokens = Object.values(block.files).reduce((sum, c) => sum + estimateTokens(c), 0);
      console.log(`  ${GREEN}\u2713${RESET} ${block.name} (${tokens.toLocaleString()} tokens)`);
    }

    console.log();
    console.log(SEP);
    console.log(`  Written to ${outPath}`);
    console.log(`  Total: ${result.totalTokens.toLocaleString()} tokens`);
  }

  // Budget warning
  if (flags.budget) {
    const totalTokens = blocks.reduce((sum, b) =>
      sum + Object.values(b.files).reduce((s, c) => s + estimateTokens(c), 0), 0);
    if (totalTokens > flags.budget) {
      console.log();
      console.log(`${YELLOW}Warning:${RESET} ${totalTokens.toLocaleString()} tokens exceeds budget of ${flags.budget.toLocaleString()}`);
      console.log(`  Run: lingot add <blocks> --budget ${flags.budget} to auto-trim`);
    }
  }

  console.log();
}
