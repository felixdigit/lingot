import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// ── ANSI colors ──

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

// ── Anthropic client (lazy init) ──

let _client = null;

function getClient() {
  if (!_client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error(`${RED}Error: ANTHROPIC_API_KEY environment variable is not set.${RESET}`);
      console.error('Set it with: export ANTHROPIC_API_KEY=sk-ant-...');
      process.exit(1);
    }
    _client = new Anthropic();
  }
  return _client;
}

// ── HTML text extraction ──

/**
 * Strip HTML to plain text without external dependencies.
 * Removes script/style blocks, strips tags, collapses whitespace.
 * Limits output to ~50,000 characters to fit in context.
 */
function extractTextFromHtml(html) {
  let text = html;

  // Remove script tags and their content
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove style tags and their content
  text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // Remove SVG tags and their content
  text = text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '');

  // Replace common block-level tags with newlines for readability
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav)>/gi, '\n');
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n');

  // Strip all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text.replace(/&nbsp;/gi, ' ');
  text = text.replace(/&amp;/gi, '&');
  text = text.replace(/&lt;/gi, '<');
  text = text.replace(/&gt;/gi, '>');
  text = text.replace(/&quot;/gi, '"');
  text = text.replace(/&#39;/gi, "'");
  text = text.replace(/&#x27;/gi, "'");
  text = text.replace(/&rsquo;/gi, "'");
  text = text.replace(/&lsquo;/gi, "'");
  text = text.replace(/&rdquo;/gi, '"');
  text = text.replace(/&ldquo;/gi, '"');
  text = text.replace(/&mdash;/gi, '—');
  text = text.replace(/&ndash;/gi, '–');
  text = text.replace(/&#\d+;/g, '');

  // Collapse whitespace: multiple spaces → single space, preserve newlines
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/\n[ \t]+/g, '\n');
  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  text = text.trim();

  // Limit to ~50,000 characters
  if (text.length > 50000) {
    text = text.substring(0, 50000);
    text += '\n\n[Content truncated at 50,000 characters]';
  }

  return text;
}

// ── Token estimation ──

/**
 * Estimate token count using chars/4 heuristic.
 */
function estimateTokens(text) {
  return Math.round(text.length / 4);
}

// ── Slug generation ──

/**
 * Generate a URL-safe slug from a string.
 */
function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

/**
 * Derive a slug from a URL (domain + path hint).
 */
function slugFromUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '').split('.')[0];
    const pathParts = u.pathname.split('/').filter(Boolean);
    const hint = pathParts.slice(0, 2).join('-');
    return slugify(hint ? `${host}-${hint}` : host);
  } catch {
    return 'mined-block';
  }
}

// ── Mining prompt ──

function buildMiningPrompt(slug, url, today) {
  return `You are a Lingot intelligence block miner. Given documentation content, you generate a complete intelligence block consisting of 4 files.

Your output must be EXACTLY in this format with these delimiters:

===KNOWLEDGE.MD===
[Dense domain knowledge, mental models, architecture patterns. Target ~1200-1500 tokens. Compress aggressively — every sentence must earn its tokens. Use markdown headings, bullet points, and code snippets. Focus on what an AI coding assistant needs to know to generate correct code.]

===RULES.XML===
[ALWAYS/NEVER heuristic rules in XML format. Target 8-15 rules. Focus on hallucination cliffs — specific patterns where LLMs consistently generate wrong code.]

The XML must use this exact structure:
<heuristics>
  <rule id="rule-id" severity="error|warning">
    <description>ALWAYS/NEVER [specific actionable rule]</description>
    <rationale>Why this matters — the specific failure mode it prevents.</rationale>
  </rule>
</heuristics>

===EXAMPLES.YAML===
[3-6 few-shot examples in YAML format. Each example has input (prompt) and output (correct code). Focus on the most common tasks and the trickiest patterns.]

Use this exact structure:
examples:
  - id: example-id
    tags: [relevant, tags]
    description: "What this example demonstrates"
    input: |
      [A realistic prompt an engineer would type]
    output: |
      [The correct code/response]

===LINGOT.JSON===
[Metadata in JSON format. Fill in all fields accurately based on the documentation content.]

{
  "$schema": "https://lingot.sh/schema/v2",
  "name": "${slug}",
  "version": "1.0.0",
  "description": "[1-2 sentence description of what this block teaches an AI assistant]",
  "author": "Telos Core",
  "license": "MIT",
  "domain": "[frontend|backend|database|auth|payments|testing|devops|devtools|ai|language|architecture]",
  "category": "developer",
  "keywords": ["keyword1", "keyword2", "keyword3"],
  "targetDependencies": {},
  "requires": [],
  "enhances": [],
  "conflicts": [],
  "tokens": { "knowledge": 0, "rules": 0, "examples": 0, "total": 0 },
  "sources": [{ "title": "[Page title or doc section name]", "url": "${url}" }],
  "quality": {
    "maintenance": "active",
    "verified": "auto-mined",
    "timestamp": "${today}",
    "source_tokens": 0,
    "scope": {
      "type": "concept_map",
      "description": "[Brief description of what this block covers]",
      "total_items": 0,
      "covered_items": 0,
      "items": ["item1", "item2", "item3"]
    }
  }
}

IMPORTANT:
- The tokens field in lingot.json should have placeholder 0 values — they will be computed after generation.
- Do NOT wrap file contents in markdown code fences. Output raw content between delimiters.
- For RULES.XML, output raw XML (no \`\`\`xml fences).
- For EXAMPLES.YAML, output raw YAML (no \`\`\`yaml fences).
- For LINGOT.JSON, output raw JSON (no \`\`\`json fences).
- Be precise and technical. Every token must earn its place.`;
}

// ── Parse Claude's response into 4 files ──

function parseMiningResponse(response) {
  const files = {};

  const delimiters = [
    { key: 'knowledge.md', marker: '===KNOWLEDGE.MD===' },
    { key: 'rules.xml', marker: '===RULES.XML===' },
    { key: 'examples.yaml', marker: '===EXAMPLES.YAML===' },
    { key: 'lingot.json', marker: '===LINGOT.JSON===' },
  ];

  for (let i = 0; i < delimiters.length; i++) {
    const startMarker = delimiters[i].marker;
    const endMarker = delimiters[i + 1]?.marker;

    const startIdx = response.indexOf(startMarker);
    if (startIdx === -1) {
      throw new Error(`Missing delimiter in response: ${startMarker}`);
    }

    const contentStart = startIdx + startMarker.length;
    let contentEnd;

    if (endMarker) {
      contentEnd = response.indexOf(endMarker);
      if (contentEnd === -1) {
        throw new Error(`Missing delimiter in response: ${endMarker}`);
      }
    } else {
      contentEnd = response.length;
    }

    files[delimiters[i].key] = response.substring(contentStart, contentEnd).trim();
  }

  return files;
}

// ── Update token counts in lingot.json ──

function updateTokenCounts(files, sourceTokens) {
  const knowledgeTokens = estimateTokens(files['knowledge.md']);
  const rulesTokens = estimateTokens(files['rules.xml']);
  const examplesTokens = estimateTokens(files['examples.yaml']);
  const totalTokens = knowledgeTokens + rulesTokens + examplesTokens;

  try {
    const manifest = JSON.parse(files['lingot.json']);
    manifest.tokens = {
      knowledge: knowledgeTokens,
      rules: rulesTokens,
      examples: examplesTokens,
      total: totalTokens,
    };
    if (manifest.quality) {
      manifest.quality.source_tokens = sourceTokens;
    }
    files['lingot.json'] = JSON.stringify(manifest, null, 2);
  } catch (err) {
    console.error(`${DIM}Warning: Could not update token counts in lingot.json: ${err.message}${RESET}`);
  }

  return { knowledgeTokens, rulesTokens, examplesTokens, totalTokens };
}

// ── Main mine function ──

export async function mine(url, options = {}) {
  const { output, name } = options;

  // ── 1. Derive slug ──
  const slug = name || slugFromUrl(url);
  const outputDir = resolve(output || join('.', 'blocks', slug));
  const today = new Date().toISOString().split('T')[0];

  console.log();
  console.log(`${BOLD}Lingot Miner${RESET}`);
  console.log(`${DIM}URL:    ${url}${RESET}`);
  console.log(`${DIM}Slug:   ${slug}${RESET}`);
  console.log(`${DIM}Output: ${outputDir}${RESET}`);
  console.log();

  // ── 2. Fetch the URL ──
  console.log(`${CYAN}Fetching documentation...${RESET}`);

  let rawHtml;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Lingot-Miner/1.0 (intelligence block generator)',
        'Accept': 'text/html,application/xhtml+xml,text/plain,*/*',
      },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }
    rawHtml = await res.text();
  } catch (err) {
    console.error(`${RED}Failed to fetch URL: ${err.message}${RESET}`);
    process.exit(1);
  }

  console.log(`${DIM}  Fetched ${rawHtml.length.toLocaleString()} bytes${RESET}`);

  // ── 3. Extract text ──
  console.log(`${CYAN}Extracting text content...${RESET}`);
  const textContent = extractTextFromHtml(rawHtml);
  const sourceTokens = estimateTokens(textContent);
  console.log(`${DIM}  Extracted ${textContent.length.toLocaleString()} chars (~${sourceTokens.toLocaleString()} tokens)${RESET}`);

  if (textContent.length < 100) {
    console.error(`${RED}Extracted text is too short (${textContent.length} chars). The URL may not contain useful documentation.${RESET}`);
    process.exit(1);
  }

  // ── 4. Send to Claude API ──
  console.log(`${CYAN}Mining intelligence block with Claude...${RESET}`);

  const client = getClient();
  const systemPrompt = buildMiningPrompt(slug, url, today);

  let response;
  try {
    const result = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 8192,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Here is the documentation content to mine into an intelligence block:\n\n<documentation>\n${textContent}\n</documentation>\n\nGenerate the complete intelligence block (knowledge.md, rules.xml, examples.yaml, lingot.json) using the exact delimiter format specified.`,
        },
      ],
    });

    response = result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  } catch (err) {
    console.error(`${RED}Claude API error: ${err.message}${RESET}`);
    process.exit(1);
  }

  console.log(`${DIM}  Received ${response.length.toLocaleString()} chars from Claude${RESET}`);

  // ── 5. Parse response into files ──
  console.log(`${CYAN}Parsing block files...${RESET}`);

  let files;
  try {
    files = parseMiningResponse(response);
  } catch (err) {
    console.error(`${RED}Failed to parse Claude's response: ${err.message}${RESET}`);
    console.error(`${DIM}This can happen if the documentation content confused the model.${RESET}`);
    console.error(`${DIM}Try again or use --name to specify a different slug.${RESET}`);

    // Dump raw response for debugging
    const debugPath = resolve(output || '.', `mine-debug-${slug}.txt`);
    mkdirSync(resolve(output || '.'), { recursive: true });
    writeFileSync(debugPath, response);
    console.error(`${DIM}Raw response saved to: ${debugPath}${RESET}`);
    process.exit(1);
  }

  // ── 6. Update token counts ──
  const tokens = updateTokenCounts(files, sourceTokens);

  // ── 7. Write files to output directory ──
  console.log(`${CYAN}Writing block files...${RESET}`);

  mkdirSync(outputDir, { recursive: true });

  for (const [filename, content] of Object.entries(files)) {
    const filePath = join(outputDir, filename);
    writeFileSync(filePath, content + '\n');
    console.log(`${DIM}  ${filename} (${content.length.toLocaleString()} chars)${RESET}`);
  }

  // ── 8. Summary ──
  console.log();
  console.log(`${GREEN}${BOLD}Done!${RESET} Intelligence block mined successfully.`);
  console.log();
  console.log(`  ${BOLD}Block:${RESET}    ${slug}`);
  console.log(`  ${BOLD}Output:${RESET}   ${outputDir}`);
  console.log(`  ${BOLD}Source:${RESET}   ~${sourceTokens.toLocaleString()} tokens from documentation`);
  console.log(`  ${BOLD}Tokens:${RESET}   ${tokens.totalTokens.toLocaleString()} total`);
  console.log(`            knowledge: ${tokens.knowledgeTokens.toLocaleString()}`);
  console.log(`            rules:     ${tokens.rulesTokens.toLocaleString()}`);
  console.log(`            examples:  ${tokens.examplesTokens.toLocaleString()}`);
  console.log();
  console.log(`  Next steps:`);
  console.log(`    lingot validate ${outputDir}`);
  console.log(`    lingot add ${outputDir}`);
  console.log();
}
