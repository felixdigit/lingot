/**
 * Token budget knapsack algorithm.
 * Rescued from lingot-core-v1/src/budget.ts, simplified to work on
 * flat Rule[] and Example[] arrays instead of full Block objects.
 *
 * Drop order: examples first (lowest priority) -> truncate knowledge -> keep rules.
 */

import type { Rule, Example } from "./types";
import { estimateTokens } from "./tokenizer";

const DEFAULT_RULES_PRIORITY = 100;
const DEFAULT_EXAMPLES_PRIORITY = 10;

interface BudgetResult {
  keptRules: Rule[];
  keptExamples: Example[];
  budgetedKnowledge: string;
  examplesDropped: number;
  knowledgeTruncated: boolean;
}

/**
 * Apply token budget across knowledge, rules, and examples.
 *
 * Priority: rules (keep all) > knowledge (truncate at paragraphs) > examples (drop lowest priority first).
 * If rules alone exceed budget, they're included anyway with a console warning.
 */
export function applyBudget(
  knowledge: string,
  rules: Rule[],
  examples: Example[],
  budgetLimit: number,
): BudgetResult {
  const rulesTokens = rules.reduce((sum, r) => sum + r.tokens, 0);
  const knowledgeTokens = estimateTokens(knowledge);
  const examplesTokens = examples.reduce((sum, e) => sum + e.tokens, 0);
  const totalTokens = rulesTokens + knowledgeTokens + examplesTokens;

  // Everything fits
  if (totalTokens <= budgetLimit) {
    return {
      keptRules: rules,
      keptExamples: examples,
      budgetedKnowledge: knowledge,
      examplesDropped: 0,
      knowledgeTruncated: false,
    };
  }

  // Rules alone exceed budget -- warn but include them
  if (rulesTokens > budgetLimit) {
    console.warn(
      `[lingot-policy] Rules alone (${rulesTokens} tokens) exceed budget (${budgetLimit}). Including all rules anyway.`,
    );
    return {
      keptRules: rules,
      keptExamples: [],
      budgetedKnowledge: "",
      examplesDropped: examples.length,
      knowledgeTruncated: knowledge.length > 0,
    };
  }

  // Budget remaining after rules
  let remaining = budgetLimit - rulesTokens;

  // Allocate examples FIRST (they define output format -- dropping them breaks parsing)
  const sortedExamples = [...examples].sort((a, b) => {
    const pa = a.priority ?? DEFAULT_EXAMPLES_PRIORITY;
    const pb = b.priority ?? DEFAULT_EXAMPLES_PRIORITY;
    if (pa !== pb) return pb - pa; // higher priority first
    return a.tokens - b.tokens; // smaller examples first (fit more)
  });

  const keptExamples: Example[] = [];
  let examplesDropped = 0;

  for (const example of sortedExamples) {
    if (example.tokens <= remaining) {
      keptExamples.push(example);
      remaining -= example.tokens;
    } else {
      examplesDropped++;
    }
  }

  // Then fit knowledge into whatever budget remains
  let budgetedKnowledge: string;
  let knowledgeTruncated = false;

  if (knowledgeTokens <= remaining) {
    budgetedKnowledge = knowledge;
    remaining -= knowledgeTokens;
  } else {
    budgetedKnowledge = truncateAtParagraphBoundary(knowledge, remaining);
    knowledgeTruncated = budgetedKnowledge.length < knowledge.length;
  }

  return {
    keptRules: rules,
    keptExamples,
    budgetedKnowledge,
    examplesDropped,
    knowledgeTruncated,
  };
}

/**
 * Truncate text at paragraph boundaries to fit within a token budget.
 * Keeps as many leading paragraphs as fit.
 */
function truncateAtParagraphBoundary(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return "";

  const paragraphs = text.split(/\n\n+/);
  const kept: string[] = [];

  for (const paragraph of paragraphs) {
    const candidate = kept.length > 0
      ? kept.join("\n\n") + "\n\n" + paragraph
      : paragraph;

    if (estimateTokens(candidate) <= maxTokens) {
      kept.push(paragraph);
    } else {
      break;
    }
  }

  return kept.join("\n\n");
}
