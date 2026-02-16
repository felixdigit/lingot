import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PACKAGES_DIR } from './config.js';

/**
 * Format a number with commas: 15000 -> "15,000"
 */
function fmt(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Estimate token count from a string.
 * Rough heuristic: 1 token ~= 4 characters for English text.
 */
function estimateTokens(content) {
  return Math.ceil(content.length / 4);
}

/**
 * Read a block's file sizes (in tokens) from disk.
 * Returns { rules, knowledge, examples, total } with actual token counts
 * based on installed file content.
 *
 * @param {string} blockName - Name of the installed block
 * @returns {object} Token counts per file type
 */
function getBlockTokenCounts(blockName) {
  const dir = join(PACKAGES_DIR, blockName);
  const counts = { rules: 0, knowledge: 0, examples: 0, total: 0 };

  const files = {
    rules: 'rules.xml',
    knowledge: 'knowledge.md',
    examples: 'examples.yaml',
  };

  for (const [key, filename] of Object.entries(files)) {
    const filePath = join(dir, filename);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      counts[key] = estimateTokens(content);
    }
  }

  counts.total = counts.rules + counts.knowledge + counts.examples;
  return counts;
}

/**
 * Apply a token budget across multiple installed blocks using a priority knapsack.
 *
 * Priority order (never drop higher priority before lower):
 *   1. rules.xml     — never drop
 *   2. knowledge.md  — truncate if needed
 *   3. examples.yaml — drop first
 *
 * @param {string[]} blockNames - List of block names that have been installed
 * @param {number} budget       - Maximum token budget
 * @returns {object} { totalBefore, totalAfter, actions[] }
 */
export function applyBudget(blockNames, budget) {
  const blocks = blockNames.map(name => ({
    name,
    tokens: getBlockTokenCounts(name),
  }));

  const totalBefore = blocks.reduce((sum, b) => sum + b.tokens.total, 0);

  // If we're already under budget, nothing to do
  if (totalBefore <= budget) {
    return {
      totalBefore,
      totalAfter: totalBefore,
      actions: [],
      blocks,
    };
  }

  const actions = [];
  let currentTotal = totalBefore;

  // Phase 1: Drop examples.yaml starting from the block with the smallest examples
  // (least information lost per drop)
  const blocksWithExamples = blocks
    .filter(b => b.tokens.examples > 0)
    .sort((a, b) => a.tokens.examples - b.tokens.examples);

  for (const block of blocksWithExamples) {
    if (currentTotal <= budget) break;

    const examplesPath = join(PACKAGES_DIR, block.name, 'examples.yaml');
    if (existsSync(examplesPath)) {
      const saved = block.tokens.examples;
      // Write an empty placeholder so the file still exists but is effectively empty
      writeFileSync(examplesPath,
        `# examples.yaml dropped to fit token budget (saved ~${fmt(saved)} tokens)\n`
      );
      currentTotal -= saved;
      block.tokens.examples = 0;
      block.tokens.total -= saved;
      actions.push(`Dropped: ${block.name}/examples.yaml (${fmt(saved)} tokens)`);
    }
  }

  // Phase 2: Truncate knowledge.md starting from the block with the largest knowledge
  // (biggest savings per truncation)
  if (currentTotal > budget) {
    const blocksWithKnowledge = blocks
      .filter(b => b.tokens.knowledge > 0)
      .sort((a, b) => b.tokens.knowledge - a.tokens.knowledge);

    for (const block of blocksWithKnowledge) {
      if (currentTotal <= budget) break;

      const knowledgePath = join(PACKAGES_DIR, block.name, 'knowledge.md');
      if (!existsSync(knowledgePath)) continue;

      const content = readFileSync(knowledgePath, 'utf-8');
      const lines = content.split('\n');
      const overshoot = currentTotal - budget;

      // Figure out how many tokens we need to cut
      const tokensToSave = Math.min(overshoot, block.tokens.knowledge);
      const targetKnowledgeTokens = block.tokens.knowledge - tokensToSave;

      // Keep enough lines to stay within the target token count
      let keptTokens = 0;
      let keepLines = 0;
      for (let i = 0; i < lines.length; i++) {
        const lineTokens = estimateTokens(lines[i] + '\n');
        if (keptTokens + lineTokens > targetKnowledgeTokens) break;
        keptTokens += lineTokens;
        keepLines = i + 1;
      }

      // Ensure we keep at least a few lines
      keepLines = Math.max(keepLines, Math.min(5, lines.length));

      const truncated = lines.slice(0, keepLines).join('\n')
        + `\n\n<!-- truncated to fit ${fmt(budget)} token budget -->\n`;

      writeFileSync(knowledgePath, truncated);

      const oldTokens = block.tokens.knowledge;
      block.tokens.knowledge = estimateTokens(truncated);
      const saved = oldTokens - block.tokens.knowledge;
      block.tokens.total -= saved;
      currentTotal -= saved;

      actions.push(`Truncated: ${block.name}/knowledge.md (saved ${fmt(saved)} tokens, kept ${keepLines}/${lines.length} lines)`);
    }
  }

  return {
    totalBefore,
    totalAfter: currentTotal,
    actions,
    blocks,
  };
}

/**
 * Print a budget summary to the console.
 */
export function printBudgetSummary(budget, blockNames, result) {
  console.log();
  console.log(`Budget: ${fmt(budget)} tokens. Installing ${blockNames.length} blocks (${fmt(result.totalAfter)} tokens).`);

  if (result.actions.length > 0) {
    for (const action of result.actions) {
      console.log(`  ${action}`);
    }
  }

  if (result.totalAfter > budget) {
    console.log(`  Warning: Could not fit within budget. Total: ${fmt(result.totalAfter)} tokens (${fmt(result.totalAfter - budget)} over).`);
    console.log(`  Note: rules.xml files are never dropped.`);
  }
}
