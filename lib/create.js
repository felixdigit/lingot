import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';

const KNOWLEDGE_TEMPLATE = `# {{NAME}}

## Mental Model

[What this library/framework is and how it works. Cover the core abstraction.]

## Core API

[The primary patterns developers need. Focus on what models get wrong.]

## Common Patterns

[Patterns that come up in real projects. Include version-specific changes.]
`;

const RULES_TEMPLATE = `<heuristics>
  <rule id="example-rule">
    Use the current API pattern for {{NAME}}. [Describe the correct approach.]
  </rule>
</heuristics>
`;

const EXAMPLES_TEMPLATE = `- id: basic-usage
  tags: [{{SLUG}}]
  input: "[Describe a common task using {{NAME}}]"
  output: |
    // Correct implementation here
`;

function createManifest(name) {
  return JSON.stringify({
    "$schema": "https://lingot.sh/schema/v2",
    name,
    version: "1.0.0",
    description: "",
    author: "",
    license: "MIT",
    domain: "frontend",
    category: "developer",
    keywords: [name],
    requires: [],
    enhances: [],
    conflicts: [],
    tokens: {
      knowledge: 0,
      rules: 0,
      examples: 0,
      total: 0
    },
    sources: []
  }, null, 2) + '\n';
}

export async function create(args = []) {
  const name = args.filter(a => !a.startsWith('--'))[0];

  if (!name) {
    console.error('Usage: lingot create <block-name>');
    console.error('  Scaffolds a new intelligence block directory.');
    process.exit(1);
  }

  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const outputDir = args.includes('--output')
    ? resolve(args[args.indexOf('--output') + 1], slug)
    : resolve(slug);

  if (existsSync(outputDir)) {
    console.error(`${YELLOW}Directory already exists:${RESET} ${outputDir}`);
    process.exit(1);
  }

  mkdirSync(outputDir, { recursive: true });

  const label = slug.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

  writeFileSync(join(outputDir, 'knowledge.md'), KNOWLEDGE_TEMPLATE.replace(/\{\{NAME\}\}/g, label));
  writeFileSync(join(outputDir, 'rules.xml'), RULES_TEMPLATE.replace(/\{\{NAME\}\}/g, label));
  writeFileSync(join(outputDir, 'examples.yaml'), EXAMPLES_TEMPLATE.replace(/\{\{NAME\}\}/g, label).replace(/\{\{SLUG\}\}/g, slug));
  writeFileSync(join(outputDir, 'lingot.json'), createManifest(slug));

  console.log();
  console.log(`${BOLD}lingot create${RESET}`);
  console.log();
  console.log(`  ${GREEN}\u2713${RESET} knowledge.md`);
  console.log(`  ${GREEN}\u2713${RESET} rules.xml`);
  console.log(`  ${GREEN}\u2713${RESET} examples.yaml`);
  console.log(`  ${GREEN}\u2713${RESET} lingot.json`);
  console.log();
  console.log(`  Created ${CYAN}${slug}${RESET} at ${DIM}${outputDir}${RESET}`);
  console.log();
  console.log(`  Next steps:`);
  console.log(`  1. Fill in ${CYAN}knowledge.md${RESET} with dense domain knowledge`);
  console.log(`  2. Add affirmative rules to ${CYAN}rules.xml${RESET}`);
  console.log(`  3. Write few-shot examples in ${CYAN}examples.yaml${RESET}`);
  console.log(`  4. Update metadata in ${CYAN}lingot.json${RESET}`);
  console.log(`  5. Run ${CYAN}npx lingot validate ./${slug}${RESET} to check`);
  console.log(`  6. Run ${CYAN}npx lingot doctor ./${slug}${RESET} to score`);
  console.log();
}
