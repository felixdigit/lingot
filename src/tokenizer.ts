/**
 * Estimate token count using a character-based heuristic.
 *
 * Uses Math.ceil(text.length / 4) -- conservative approximation that
 * overestimates for English prose and underestimates for code.
 * Accurate enough for budget allocation (not billing).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 3.5);
}
