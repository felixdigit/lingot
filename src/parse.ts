/**
 * Parse rules XML and examples YAML into typed arrays.
 * Rescued from lingot-core-v1/src/extractor.ts, simplified:
 * - No zod validation (returns empty array on failure, warns to console)
 * - No SchemaValidationError throws
 * - No ParseError throws
 */

import YAML from "yaml";
import type { Rule, Example } from "./types";
import { estimateTokens } from "./tokenizer";

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

function stripMarkdownFences(text: string): string {
  return text.replace(/^```[a-z]*\n/i, "").replace(/\n```$/i, "").trim();
}

/**
 * Parse rules XML string into Rule[].
 * Expects: <rule id="rule-id">rule content</rule> elements.
 * Returns empty array if parsing fails.
 */
export function parseRules(rulesXml: string): Rule[] {
  if (!rulesXml.trim()) return [];

  const rulePattern = /<rule\s+id="([^"]+)">([\s\S]*?)<\/rule>/g;
  const rules: Rule[] = [];
  let match: RegExpExecArray | null;

  while ((match = rulePattern.exec(rulesXml)) !== null) {
    const id = match[1].trim();
    const content = unescapeXml(match[2].trim());
    rules.push({ id, content, tokens: estimateTokens(content) });
  }

  if (rules.length === 0) {
    console.warn("[lingot-policy] No <rule> elements found in rules XML");
  }

  return rules;
}

/**
 * Parse examples YAML string into Example[].
 * Expects YAML array with: id, tags, input, output, annotation? fields.
 * Returns empty array if parsing fails.
 */
export function parseExamples(examplesYaml: string): Example[] {
  if (!examplesYaml.trim()) return [];

  let parsed: unknown;
  try {
    parsed = YAML.parse(stripMarkdownFences(examplesYaml));
  } catch (err) {
    console.warn("[lingot-policy] Failed to parse examples YAML:", err);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.warn("[lingot-policy] Examples YAML is not an array");
    return [];
  }

  return parsed
    .filter((item) => item && typeof item === "object" && item.id)
    .map((item) => {
      const input = String(item.input ?? "");
      const output = String(item.output ?? "");
      const annotation = item.annotation != null ? String(item.annotation) : undefined;
      return {
        id: String(item.id),
        tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        input,
        output,
        annotation,
        tokens: estimateTokens(input + output + (annotation ?? "")),
        priority: typeof item.priority === "number" ? item.priority : undefined,
      };
    });
}
