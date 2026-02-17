import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { PACKAGES_DIR } from './config.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

const ATTENTION_THRESHOLD = 8000;
// Deep Think 047: LINT-004 threshold — if rules tokens exceed this ratio of total, flag it
const RULE_KNOWLEDGE_RATIO_THRESHOLD = 0.5; // rules > 50% of block = instructional bloat

function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}


/**
 * LINT-004: Instructional Bloat (replaces LINT-001 per Deep Think 047)
 * B-2 proved rules of ANY polarity add marginal noise. Knowledge carries 98%+ of signal.
 * Flag blocks where rule tokens exceed 50% of total — the block is yelling heuristics
 * instead of providing declarative state.
 */
function lintInstructionalBloat(blockName, blockDir, totalTokens) {
  const rulesPath = join(blockDir, 'rules.xml');
  if (!existsSync(rulesPath)) return [];

  const rulesTokens = estimateTokens(readFileSync(rulesPath, 'utf-8'));
  const ratio = rulesTokens / totalTokens;

  if (ratio <= RULE_KNOWLEDGE_RATIO_THRESHOLD) return [];

  return [{
    lint: 'LINT-004',
    severity: 'warning',
    penalty: -15,
    block: blockName,
    rule: null,
    message: `Rules account for ${(ratio * 100).toFixed(0)}% of tokens (${rulesTokens}/${totalTokens}). Rules yield <53% accuracy alone. Convert heuristic rules to declarative knowledge.`,
  }];
}

/**
 * LINT-002: Attention Dilution
 * Block exceeds token threshold. -10 pts.
 */
function lintAttentionDilution(blockName, totalTokens) {
  if (totalTokens <= ATTENTION_THRESHOLD) return [];
  return [{
    lint: 'LINT-002',
    severity: 'warning',
    penalty: -10,
    block: blockName,
    rule: null,
    message: `${totalTokens.toLocaleString()} tokens (threshold: ${ATTENTION_THRESHOLD.toLocaleString()}) — consider splitting or trimming`,
  }];
}

/**
 * LINT-003: Latent Collision
 * Scope overlap between co-loaded blocks. -20 pts per collision.
 */
function lintLatentCollisions(blocks) {
  const findings = [];
  const blockMeta = [];

  for (const block of blocks) {
    let manifest = null;
    for (const mf of ['lingot.json', 'manifest.json']) {
      const mp = join(block.dir, mf);
      if (existsSync(mp)) {
        try { manifest = JSON.parse(readFileSync(mp, 'utf-8')); } catch {}
        break;
      }
    }
    if (!manifest) continue;

    // Check explicit conflicts
    const installed = new Set(blocks.map(b => b.name));
    for (const c of (manifest.conflicts || [])) {
      if (installed.has(c)) {
        findings.push({
          lint: 'LINT-003',
          severity: 'error',
          penalty: -20,
          block: block.name,
          rule: null,
          message: `Declares conflict with "${c}" — loading both causes contradictions`,
        });
      }
    }

    blockMeta.push({
      name: block.name,
      domain: manifest.domain,
      keywords: new Set(manifest.keywords || []),
    });
  }

  // Pairwise domain collision
  for (let i = 0; i < blockMeta.length; i++) {
    for (let j = i + 1; j < blockMeta.length; j++) {
      const a = blockMeta[i];
      const b = blockMeta[j];
      if (a.domain && b.domain && a.domain === b.domain) {
        const overlap = [...a.keywords].filter(k => b.keywords.has(k));
        if (overlap.length >= 3) {
          findings.push({
            lint: 'LINT-003',
            severity: 'warning',
            penalty: -20,
            block: `${a.name} + ${b.name}`,
            rule: null,
            message: `Domain collision: both "${a.domain}" with ${overlap.length} shared keywords (${overlap.slice(0, 3).join(', ')})`,
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Read a single block directory into a block object.
 */
function readBlock(blockDir, name) {
  const rulesPath = join(blockDir, 'rules.xml');
  const knowledgePath = join(blockDir, 'knowledge.md');
  const examplesPath = join(blockDir, 'examples.yaml');

  if (!existsSync(rulesPath) && !existsSync(knowledgePath)) return null;

  let totalTokens = 0;
  let rulesXml = null;

  if (existsSync(knowledgePath)) {
    totalTokens += estimateTokens(readFileSync(knowledgePath, 'utf-8'));
  }
  if (existsSync(rulesPath)) {
    rulesXml = readFileSync(rulesPath, 'utf-8');
    totalTokens += estimateTokens(rulesXml);
  }
  if (existsSync(examplesPath)) {
    totalTokens += estimateTokens(readFileSync(examplesPath, 'utf-8'));
  }

  return { name, dir: blockDir, tokens: totalTokens, rulesXml };
}

/**
 * Scan a directory for blocks. If the directory itself is a block, return it as a single-element array.
 */
function scanBlocks(dir) {
  // Check if dir itself is a block
  if (existsSync(join(dir, 'rules.xml')) || existsSync(join(dir, 'knowledge.md'))) {
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

export async function doctor(args = []) {
  const reportMode = args.includes('--report');
  const minScoreIdx = args.indexOf('--min-score');
  const minScore = minScoreIdx !== -1 && args[minScoreIdx + 1]
    ? Number(args[minScoreIdx + 1])
    : 70;
  const dirArg = args.find(a => !a.startsWith('--') && isNaN(Number(a)));
  const scanDir = dirArg ? resolve(dirArg) : PACKAGES_DIR;

  if (!existsSync(scanDir)) {
    console.error(`Directory not found: ${scanDir}`);
    console.error('');
    console.error('Usage: lingot doctor [directory] [--report]');
    console.error(`Default: ${PACKAGES_DIR}`);
    process.exit(1);
  }

  const blocks = scanBlocks(scanDir);

  if (blocks.length === 0) {
    console.error('No blocks found to scan.');
    console.error(`Scanned: ${scanDir}`);
    process.exit(1);
  }

  // Run all lints
  const allFindings = [];

  for (const block of blocks) {
    allFindings.push(...lintInstructionalBloat(block.name, block.dir, block.tokens));
    allFindings.push(...lintAttentionDilution(block.name, block.tokens));
  }
  allFindings.push(...lintLatentCollisions(blocks));

  // Score
  const totalPenalty = allFindings.reduce((sum, f) => sum + f.penalty, 0);
  const score = Math.max(0, 100 + totalPenalty);
  const totalTokens = blocks.reduce((sum, b) => sum + b.tokens, 0);

  // Print
  const SEP = '\u2500'.repeat(60);

  console.log();
  console.log(`${BOLD}lingot doctor${RESET}`);
  console.log(SEP);
  console.log(`${DIM}Scanned: ${scanDir}${RESET}`);
  console.log(`${DIM}Blocks:  ${blocks.length}${RESET}`);
  console.log(`${DIM}Tokens:  ${totalTokens.toLocaleString()}${RESET}`);
  console.log();

  if (allFindings.length === 0) {
    console.log(`  ${GREEN}\u2713${RESET} No issues found. Your context is clean.`);
  } else {
    const byLint = {};
    for (const f of allFindings) {
      if (!byLint[f.lint]) byLint[f.lint] = [];
      byLint[f.lint].push(f);
    }

    for (const [lint, findings] of Object.entries(byLint)) {
      const color = findings[0].severity === 'error' ? RED : YELLOW;
      console.log(`  ${color}${lint}${RESET} (${findings.length} issue${findings.length > 1 ? 's' : ''}, ${findings[0].penalty} pts each)`);

      for (const f of findings) {
        const icon = f.severity === 'error' ? `${RED}\u2717${RESET}` : `${YELLOW}!${RESET}`;
        console.log(`    ${icon} ${f.block}${f.rule ? `/${f.rule}` : ''}: ${f.message}`);
      }
      console.log();
    }
  }

  // Score output
  console.log(SEP);
  let scoreColor;
  if (score >= 90) scoreColor = GREEN;
  else if (score >= 70) scoreColor = YELLOW;
  else scoreColor = RED;

  console.log(`  Context Health Score: ${scoreColor}${BOLD}${score}/100${RESET}`);

  if (score < 100) {
    const errorCount = allFindings.filter(f => f.severity === 'error').length;
    const warnCount = allFindings.filter(f => f.severity === 'warning').length;
    console.log(`  ${errorCount} error${errorCount !== 1 ? 's' : ''}, ${warnCount} warning${warnCount !== 1 ? 's' : ''}`);
  }
  console.log();

  // --report: machine-readable JSON for CI / lead gen
  if (reportMode) {
    const report = {
      score,
      blocks: blocks.length,
      totalTokens,
      findings: allFindings.map(f => ({
        lint: f.lint,
        severity: f.severity,
        block: f.block,
        rule: f.rule,
        message: f.message,
      })),
      scannedAt: new Date().toISOString(),
    };
    console.log(JSON.stringify(report, null, 2));
  }

  if (score < minScore) {
    if (minScore !== 70) {
      console.log(`${RED}Failed:${RESET} score ${score} is below --min-score ${minScore}`);
      console.log();
    }
    process.exit(1);
  }
}
