/**
 * Format compiled block content into an Anthropic-ready system prompt string.
 * Uses strict XML-tagged sections that Anthropic models are RLHF'd to follow.
 * Omits empty sections entirely.
 */

import type { Rule, Example, TextBlock } from "./types";

export function formatSystemPrompt(
  knowledge: string,
  rules: Rule[],
  examples: Example[],
): string {
  const sections: string[] = [];

  if (knowledge.trim()) {
    sections.push(`<knowledge>\n${knowledge.trim()}\n</knowledge>`);
  }

  if (rules.length > 0) {
    const rulesXml = rules
      .map((r) => `  <rule id="${escapeAttr(r.id)}">${r.content}</rule>`)
      .join("\n");
    sections.push(`<rules>\n${rulesXml}\n</rules>`);
  }

  if (examples.length > 0) {
    const exXml = examples
      .map((e) => {
        const parts = [
          `  <example id="${escapeAttr(e.id)}">`,
          `    <input>${escapeContent(e.input)}</input>`,
          `    <output>${escapeContent(e.output)}</output>`,
        ];
        if (e.annotation) {
          parts.push(`    <annotation>${escapeContent(e.annotation)}</annotation>`);
        }
        parts.push(`  </example>`);
        return parts.join("\n");
      })
      .join("\n");
    sections.push(`<examples>\n${exXml}\n</examples>`);
  }

  return sections.join("\n\n");
}

/**
 * Format as TextBlockParam array with cache_control on the last block.
 * Anthropic Prompt Caching requires system to be an array of objects,
 * with cache_control: { type: "ephemeral" } on the block to cache up to.
 */
export function formatSystemBlocks(
  knowledge: string,
  rules: Rule[],
  examples: Example[],
): TextBlock[] {
  const blocks: TextBlock[] = [];

  if (knowledge.trim()) {
    blocks.push({ type: "text", text: `<knowledge>\n${knowledge.trim()}\n</knowledge>` });
  }

  if (rules.length > 0) {
    const rulesXml = rules
      .map((r) => `  <rule id="${escapeAttr(r.id)}">${r.content}</rule>`)
      .join("\n");
    blocks.push({ type: "text", text: `<rules>\n${rulesXml}\n</rules>` });
  }

  if (examples.length > 0) {
    const exXml = examples
      .map((e) => {
        const parts = [
          `  <example id="${escapeAttr(e.id)}">`,
          `    <input>${escapeContent(e.input)}</input>`,
          `    <output>${escapeContent(e.output)}</output>`,
        ];
        if (e.annotation) {
          parts.push(`    <annotation>${escapeContent(e.annotation)}</annotation>`);
        }
        parts.push(`  </example>`);
        return parts.join("\n");
      })
      .join("\n");
    blocks.push({ type: "text", text: `<examples>\n${exXml}\n</examples>` });
  }

  // Attach cache_control to the last block (cache everything up to this point)
  if (blocks.length > 0) {
    blocks[blocks.length - 1].cache_control = { type: "ephemeral" };
  }

  return blocks;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeContent(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
