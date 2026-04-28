/**
 * compileContext -- the single entry point for @nexod/lingot-policy.
 *
 * Takes raw block content (knowledge, rules, examples as strings),
 * parses structured elements, applies token budgeting, and formats
 * into an Anthropic-ready system prompt (both string and TextBlockParam[]).
 *
 * Pure function. Zero I/O. Zero side effects (aside from console.warn on parse failures).
 */

import type { BlockInput, CompileContextOptions, CompiledContext } from "./types";
import { parseRules, parseExamples } from "./parse";
import { estimateTokens } from "./tokenizer";
import { applyBudget } from "./budget";
import { formatSystemPrompt, formatSystemBlocks } from "./format";

export function compileContext(
  block: BlockInput,
  options?: CompileContextOptions,
): CompiledContext {
  const knowledge = block.knowledge?.trim() ?? "";
  const rules = block.rules ? parseRules(block.rules) : [];
  let examples = block.examples ? parseExamples(block.examples) : [];

  // Filter examples by tags if specified
  if (options?.tags && options.tags.length > 0) {
    const tagSet = new Set(options.tags);
    examples = examples.filter((e) => e.tags.some((t) => tagSet.has(t)));
  }

  // Apply token budget if specified
  if (options?.budget) {
    const result = applyBudget(knowledge, rules, examples, options.budget);
    const system = formatSystemPrompt(result.budgetedKnowledge, result.keptRules, result.keptExamples);
    const blocks = formatSystemBlocks(result.budgetedKnowledge, result.keptRules, result.keptExamples);

    return {
      system,
      blocks,
      meta: {
        knowledgeTokens: estimateTokens(result.budgetedKnowledge),
        rulesTokens: result.keptRules.reduce((s, r) => s + r.tokens, 0),
        examplesTokens: result.keptExamples.reduce((s, e) => s + e.tokens, 0),
        totalTokens: estimateTokens(system),
        budgetLimit: options.budget,
        examplesDropped: result.examplesDropped,
        knowledgeTruncated: result.knowledgeTruncated,
      },
    };
  }

  // No budget -- include everything
  const system = formatSystemPrompt(knowledge, rules, examples);
  const blocks = formatSystemBlocks(knowledge, rules, examples);

  return {
    system,
    blocks,
    meta: {
      knowledgeTokens: estimateTokens(knowledge),
      rulesTokens: rules.reduce((s, r) => s + r.tokens, 0),
      examplesTokens: examples.reduce((s, e) => s + e.tokens, 0),
      totalTokens: estimateTokens(system),
      budgetLimit: null,
      examplesDropped: 0,
      knowledgeTruncated: false,
    },
  };
}
