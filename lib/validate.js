import { readFileSync, existsSync, statSync } from 'fs';
import { join, resolve, basename } from 'path';

const REQUIRED_FILES = ['knowledge.md', 'rules.xml', 'examples.yaml', 'lingot.json'];

// Also accept legacy manifest.json as fallback
const LEGACY_MANIFEST = 'manifest.json';

const REQUIRED_MANIFEST_FIELDS = ['name', 'version', 'description', 'domain', 'category', 'keywords', 'tokens'];

/**
 * Validate a single intelligence block directory.
 * Returns { name, results[], passed, failed, warnings[] }
 */
export function validateBlock(blockDir) {
  const dir = resolve(blockDir);
  const blockName = basename(dir);
  const results = [];
  const warnings = [];

  // ── 1. Check all required files exist ──

  const fileContents = {};

  for (const file of REQUIRED_FILES) {
    const filePath = join(dir, file);
    let exists = existsSync(filePath);

    // Backwards compat: if lingot.json not found, try manifest.json
    let actualFile = file;
    let actualPath = filePath;
    if (!exists && file === 'lingot.json') {
      const legacyPath = join(dir, LEGACY_MANIFEST);
      if (existsSync(legacyPath)) {
        exists = true;
        actualFile = LEGACY_MANIFEST;
        actualPath = legacyPath;
        warnings.push('Using legacy manifest.json — consider migrating to lingot.json');
      }
    }

    results.push({
      check: `${file} exists`,
      pass: exists,
      detail: exists ? (actualFile !== file ? `(found as ${actualFile})` : null) : `Missing file: ${filePath}`,
    });
    if (exists) {
      try {
        // Store under canonical key 'lingot.json' even if read from manifest.json
        fileContents[file] = readFileSync(actualPath, 'utf-8');
      } catch (err) {
        fileContents[file] = null;
        results.push({
          check: `${file} readable`,
          pass: false,
          detail: `Cannot read file: ${err.message}`,
        });
      }
    }
  }

  // ── 2. Validate lingot.json (or legacy manifest.json) ──

  let manifest = null;

  if (fileContents['lingot.json'] != null) {
    // Valid JSON?
    try {
      manifest = JSON.parse(fileContents['lingot.json']);
      results.push({ check: 'lingot.json valid JSON', pass: true, detail: null });
    } catch (err) {
      results.push({
        check: 'lingot.json valid JSON',
        pass: false,
        detail: `JSON parse error: ${err.message}`,
      });
    }

    // Required fields?
    if (manifest) {
      const missingFields = REQUIRED_MANIFEST_FIELDS.filter(f => manifest[f] === undefined);
      results.push({
        check: 'lingot.json required fields',
        pass: missingFields.length === 0,
        detail: missingFields.length > 0 ? `Missing fields: ${missingFields.join(', ')}` : null,
      });

      // Validate tokens sub-object
      if (manifest.tokens) {
        const hasTokenFields = typeof manifest.tokens === 'object'
          && typeof manifest.tokens.knowledge === 'number'
          && typeof manifest.tokens.rules === 'number'
          && typeof manifest.tokens.examples === 'number'
          && typeof manifest.tokens.total === 'number';
        results.push({
          check: 'lingot.json tokens structure',
          pass: hasTokenFields,
          detail: hasTokenFields ? null : 'tokens must have numeric knowledge, rules, examples, total fields',
        });

        // Check that total = sum of parts
        if (hasTokenFields) {
          const sum = manifest.tokens.knowledge + manifest.tokens.rules + manifest.tokens.examples;
          const matchesSum = sum === manifest.tokens.total;
          if (!matchesSum) {
            warnings.push(`tokens.total (${manifest.tokens.total}) != knowledge + rules + examples (${sum})`);
          }
        }
      }

      // Validate arrays
      if (manifest.keywords && !Array.isArray(manifest.keywords)) {
        results.push({ check: 'lingot.json keywords is array', pass: false, detail: 'keywords must be an array' });
      }
      if (manifest.requires && !Array.isArray(manifest.requires)) {
        results.push({ check: 'lingot.json requires is array', pass: false, detail: 'requires must be an array' });
      }

      // v2 schema validations
      if (manifest.targetDependencies && typeof manifest.targetDependencies !== 'object') {
        results.push({ check: 'lingot.json targetDependencies is object', pass: false, detail: 'targetDependencies must be an object' });
      }
      if (manifest.enhances && !Array.isArray(manifest.enhances)) {
        results.push({ check: 'lingot.json enhances is array', pass: false, detail: 'enhances must be an array' });
      }
      if (manifest.conflicts && !Array.isArray(manifest.conflicts)) {
        results.push({ check: 'lingot.json conflicts is array', pass: false, detail: 'conflicts must be an array' });
      }
    }
  }

  // ── 3. Validate rules.xml ──

  if (fileContents['rules.xml'] != null) {
    const xml = fileContents['rules.xml'];

    // Starts with <heuristics>
    const hasRoot = /^\s*<heuristics\b/.test(xml);
    results.push({
      check: 'rules.xml has <heuristics> root',
      pass: hasRoot,
      detail: hasRoot ? null : 'rules.xml must start with <heuristics>',
    });

    // Closes with </heuristics>
    const hasClose = /<\/heuristics>\s*$/.test(xml);
    results.push({
      check: 'rules.xml closes </heuristics>',
      pass: hasClose,
      detail: hasClose ? null : 'rules.xml must end with </heuristics>',
    });

    // Has <rule> elements with id attributes
    const ruleMatches = xml.match(/<rule\s+id="[^"]+"/g);
    const hasRules = ruleMatches && ruleMatches.length > 0;
    results.push({
      check: 'rules.xml has <rule id="..."> elements',
      pass: hasRules,
      detail: hasRules ? `Found ${ruleMatches.length} rules` : 'No <rule id="..."> elements found',
    });

    // Check all <rule> tags have closing </rule>
    const openCount = (xml.match(/<rule\s/g) || []).length;
    const closeCount = (xml.match(/<\/rule>/g) || []).length;
    const balanced = openCount === closeCount;
    results.push({
      check: 'rules.xml balanced <rule> tags',
      pass: balanced,
      detail: balanced ? null : `${openCount} opening <rule> vs ${closeCount} closing </rule>`,
    });
  }

  // ── 4. Validate examples.yaml ──

  if (fileContents['examples.yaml'] != null) {
    const yaml = fileContents['examples.yaml'];

    // Basic YAML parse: check structure without a library.
    // Each example should be a list item with id, tags, input, output.
    // We do a lightweight structural check.
    const parseResult = parseYamlExamples(yaml);
    results.push({
      check: 'examples.yaml parseable structure',
      pass: parseResult.valid,
      detail: parseResult.valid ? `Found ${parseResult.count} examples` : parseResult.error,
    });

    if (parseResult.valid && parseResult.examples.length > 0) {
      const requiredKeys = ['id', 'tags', 'input', 'output'];
      let allHaveKeys = true;
      const missing = [];

      for (const ex of parseResult.examples) {
        for (const key of requiredKeys) {
          if (!ex.has(key)) {
            allHaveKeys = false;
            missing.push(`Example "${ex.get('id') || '(unknown)'}" missing "${key}"`);
          }
        }
      }

      results.push({
        check: 'examples.yaml required fields (id, tags, input, output)',
        pass: allHaveKeys,
        detail: allHaveKeys ? null : missing.join('; '),
      });
    }
  }

  // ── 5. Validate knowledge.md ──

  if (fileContents['knowledge.md'] != null) {
    const md = fileContents['knowledge.md'];

    // Non-empty
    const nonEmpty = md.trim().length > 0;
    results.push({
      check: 'knowledge.md is non-empty',
      pass: nonEmpty,
      detail: nonEmpty ? null : 'knowledge.md is empty',
    });

    // Has at least one heading
    const hasHeading = /^#{1,6}\s+.+/m.test(md);
    results.push({
      check: 'knowledge.md has at least one heading (#)',
      pass: hasHeading,
      detail: hasHeading ? null : 'No markdown headings found',
    });
  }

  // ── 6. Token count estimates ──

  const tokenEstimates = {};
  const tokenFiles = { 'knowledge.md': 'knowledge', 'rules.xml': 'rules', 'examples.yaml': 'examples' };
  let totalEstimate = 0;

  for (const [file, key] of Object.entries(tokenFiles)) {
    if (fileContents[file] != null) {
      const est = Math.round(fileContents[file].length / 4);
      tokenEstimates[key] = est;
      totalEstimate += est;
    }
  }
  tokenEstimates.total = totalEstimate;

  // ── Summarize ──

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  return {
    name: blockName,
    dir,
    results,
    passed,
    failed,
    warnings,
    tokenEstimates,
    manifestTokens: manifest?.tokens || null,
  };
}

/**
 * Lightweight YAML list-of-objects parser.
 * Only handles the flat list-of-mappings structure used in examples.yaml.
 * Returns { valid, count, examples: Map[], error }
 */
function parseYamlExamples(yaml) {
  try {
    const examples = [];
    let current = null;

    const lines = yaml.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // New list item: "- key: value" or "- key: |"
      const listItemMatch = line.match(/^- (\w+):\s*(.*)/);
      if (listItemMatch) {
        if (current) examples.push(current);
        current = new Map();
        const key = listItemMatch[1];
        const val = listItemMatch[2].trim();
        current.set(key, val || '(block)');
        continue;
      }

      // Continuation key in current item: "  key: value"
      const contKeyMatch = line.match(/^  (\w+):\s*(.*)/);
      if (contKeyMatch && current) {
        const key = contKeyMatch[1];
        const val = contKeyMatch[2].trim();
        current.set(key, val || '(block)');
        continue;
      }
    }

    if (current) examples.push(current);

    if (examples.length === 0) {
      return { valid: false, count: 0, examples: [], error: 'No YAML list items found (expected "- id: ..." entries)' };
    }

    return { valid: true, count: examples.length, examples };
  } catch (err) {
    return { valid: false, count: 0, examples: [], error: `YAML parse error: ${err.message}` };
  }
}

/**
 * Print validation results for a single block.
 */
export function printResults(result) {
  const PASS = '\x1b[32mPASS\x1b[0m';
  const FAIL = '\x1b[31mFAIL\x1b[0m';
  const WARN = '\x1b[33mWARN\x1b[0m';
  const SEP = '\u2500'.repeat(60);

  console.log();
  console.log(`${SEP}`);
  console.log(`  Block: ${result.name}`);
  console.log(`  Path:  ${result.dir}`);
  console.log(`${SEP}`);
  console.log();

  for (const r of result.results) {
    const status = r.pass ? PASS : FAIL;
    const detail = r.detail ? `  ${r.pass ? '' : '-> '}${r.detail}` : '';
    console.log(`  [${status}] ${r.check}${detail}`);
  }

  if (result.warnings.length > 0) {
    console.log();
    for (const w of result.warnings) {
      console.log(`  [${WARN}] ${w}`);
    }
  }

  // Token comparison
  if (result.tokenEstimates && result.manifestTokens) {
    console.log();
    console.log('  Token Estimates (chars/4) vs Manifest:');

    const keys = ['knowledge', 'rules', 'examples', 'total'];
    for (const key of keys) {
      const est = result.tokenEstimates[key] ?? '?';
      const claimed = result.manifestTokens[key] ?? '?';
      const diff = typeof est === 'number' && typeof claimed === 'number'
        ? ` (${est > claimed ? '+' : ''}${est - claimed})`
        : '';
      const prefix = key === 'total' ? '  --------\n' : '';
      console.log(`${prefix}    ${key.padEnd(12)} estimated: ${String(est).padStart(6)}   manifest: ${String(claimed).padStart(6)}${diff}`);
    }
  }

  console.log();
  const overall = result.failed === 0 ? PASS : FAIL;
  console.log(`  Result: [${overall}] ${result.passed} passed, ${result.failed} failed`);
  console.log();
}

/**
 * CLI entrypoint: validate a block directory.
 */
export async function validate(blockDir) {
  if (!blockDir) {
    console.error('Usage: lingot validate <block-directory>');
    console.error('Example: lingot validate ./packages/supabase-auth');
    process.exit(1);
  }

  const dir = resolve(blockDir);

  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const stat = statSync(dir);
  if (!stat.isDirectory()) {
    console.error(`Not a directory: ${dir}`);
    process.exit(1);
  }

  const result = validateBlock(dir);
  printResults(result);

  if (result.failed > 0) {
    process.exit(1);
  }
}
