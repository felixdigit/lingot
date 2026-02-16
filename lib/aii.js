import { readFileSync, existsSync } from 'fs';
import { join, resolve, basename } from 'path';
import { parse as parseYaml } from 'yaml';
import Anthropic from '@anthropic-ai/sdk';
import { PACKAGES_DIR } from './config.js';

// ── ANSI colors ──

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const CYAN = '\x1b[36m';
const YELLOW = '\x1b[33m';

// ── Defaults ──

const DEFAULT_GEN_MODEL = 'claude-sonnet-4-5-20250929';
const DEFAULT_JUDGE_MODEL = 'claude-haiku-4-5-20251001';
const GEN_MAX_TOKENS = 2048;
const JUDGE_MAX_TOKENS = 256;

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

// ── Load block files ──

/**
 * Resolve a block directory — checks installed packages first, then treats
 * the argument as a local path.
 */
function resolveBlockDir(nameOrPath) {
  // Check installed packages
  const installed = join(PACKAGES_DIR, nameOrPath);
  if (existsSync(installed)) return installed;

  // Check as a relative/absolute path
  const resolved = resolve(nameOrPath);
  if (existsSync(resolved)) return resolved;

  return null;
}

function loadBlockFiles(blockDir) {
  const evalsPath = join(blockDir, 'evals.yaml');
  const knowledgePath = join(blockDir, 'knowledge.md');
  const rulesPath = join(blockDir, 'rules.xml');

  if (!existsSync(evalsPath)) {
    throw new Error(`No evals.yaml found in ${blockDir}`);
  }

  const evalsRaw = readFileSync(evalsPath, 'utf-8');
  const evalsData = parseYaml(evalsRaw);

  const knowledge = existsSync(knowledgePath)
    ? readFileSync(knowledgePath, 'utf-8')
    : null;

  const rules = existsSync(rulesPath)
    ? readFileSync(rulesPath, 'utf-8')
    : null;

  return { evalsData, knowledge, rules };
}

// ── Build system context from block files ──

function buildSystemContext(knowledge, rules) {
  const parts = [];
  if (knowledge) {
    parts.push(`<knowledge>\n${knowledge}\n</knowledge>`);
  }
  if (rules) {
    parts.push(`<rules>\n${rules}\n</rules>`);
  }
  return parts.join('\n\n');
}

// ── Call Claude for code generation ──

async function generateResponse(prompt, systemContext, model) {
  const client = getClient();

  const messages = [{ role: 'user', content: prompt }];

  const params = {
    model,
    max_tokens: GEN_MAX_TOKENS,
    messages,
  };

  if (systemContext) {
    params.system = systemContext;
  }

  const response = await client.messages.create(params);

  // Extract text from content blocks
  return response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n');
}

// ── Regex helper ──

function parseRegexPattern(pattern) {
  // Convert Python-style (?flags) inline prefix to JS RegExp flags argument
  const m = pattern.match(/^\(\?([gimsuy]+)\)/);
  if (m) {
    return new RegExp(pattern.slice(m[0].length), m[1]);
  }
  return new RegExp(pattern);
}

// ── Assertion runners ──

function runRegexReject(output, pattern, reason) {
  const regex = parseRegexPattern(pattern);
  const match = regex.test(output);
  return {
    pass: !match,
    detail: match
      ? `pattern matched — found deprecated/incorrect content`
      : `no match — clean`,
    reason,
  };
}

function runRegexRequire(output, pattern, reason) {
  const regex = parseRegexPattern(pattern);
  const match = regex.test(output);
  return {
    pass: match,
    detail: match
      ? `pattern found`
      : `pattern not found`,
    reason,
  };
}

async function runLlmJudge(output, criteria) {
  const client = getClient();

  const judgePrompt = `You are an evaluation judge. You will be given an AI-generated response and a set of criteria. Evaluate whether the response meets the criteria.

<response>
${output}
</response>

<criteria>
${criteria}
</criteria>

Respond with EXACTLY one word: PASS or FAIL. Then on the next line, provide a brief one-sentence justification.`;

  const response = await client.messages.create({
    model: DEFAULT_JUDGE_MODEL,
    max_tokens: JUDGE_MAX_TOKENS,
    messages: [{ role: 'user', content: judgePrompt }],
  });

  const judgeText = response.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('\n')
    .trim();

  const firstLine = judgeText.split('\n')[0].trim().toUpperCase();
  const pass = firstLine === 'PASS';
  const justification = judgeText.split('\n').slice(1).join(' ').trim();

  return {
    pass,
    detail: justification || (pass ? 'Judge: PASS' : 'Judge: FAIL'),
    reason: criteria,
  };
}

async function runAssertion(output, assertion) {
  switch (assertion.type) {
    case 'regex_reject':
      return runRegexReject(output, assertion.pattern, assertion.reason);
    case 'regex_require':
      return runRegexRequire(output, assertion.pattern, assertion.reason);
    case 'llm_judge':
      return await runLlmJudge(output, assertion.criteria);
    default:
      return { pass: false, detail: `Unknown assertion type: ${assertion.type}`, reason: '' };
  }
}

// ── Score a set of assertion results ──

function computePassRate(results) {
  if (results.length === 0) return 0;
  const passed = results.filter(r => r.pass).length;
  return passed / results.length;
}

// ── Print helpers ──

function printAssertionResult(result, assertion, verbose) {
  const icon = result.pass ? `${GREEN}\u2713${RESET}` : `${RED}\u2717${RESET}`;
  const status = result.pass ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  const typeLabel = assertion.type;

  let summary;
  if (result.pass) {
    summary = result.detail;
  } else {
    summary = `${result.detail}`;
    if (assertion.reason && verbose) {
      summary += ` ${DIM}(${assertion.reason})${RESET}`;
    }
  }

  console.log(`    ${icon} ${typeLabel}: ${summary} (${status})`);
}

// ── Main eval runner for a single block ──

export async function runEval(nameOrPath, verbose = false) {
  const blockDir = resolveBlockDir(nameOrPath);

  if (!blockDir) {
    console.error(`Block not found: ${nameOrPath}`);
    console.error('Provide an installed block name or a path to a block directory.');
    process.exit(1);
  }

  const blockName = basename(blockDir);
  const { evalsData, knowledge, rules } = loadBlockFiles(blockDir);

  const model = evalsData.model || DEFAULT_GEN_MODEL;
  const evals = evalsData.evals || [];

  if (evals.length === 0) {
    console.error('No evals found in evals.yaml');
    process.exit(1);
  }

  const systemContext = buildSystemContext(knowledge, rules);
  const SEP = '\u2550'.repeat(40);

  console.log();
  console.log(`${BOLD}AII Test Runner \u2014 ${blockName}${RESET}`);
  console.log(SEP);
  console.log(`${DIM}Model: ${model}${RESET}`);
  console.log(`${DIM}Evals: ${evals.length}${RESET}`);
  if (knowledge) console.log(`${DIM}knowledge.md: loaded${RESET}`);
  if (rules) console.log(`${DIM}rules.xml: loaded${RESET}`);
  console.log();

  let totalBaselinePass = 0;
  let totalTreatmentPass = 0;
  let totalAssertions = 0;

  for (const evalItem of evals) {
    console.log(`${CYAN}Running eval: ${evalItem.id}${RESET}`);

    if (verbose) {
      console.log(`${DIM}  Prompt: ${evalItem.prompt.trim().substring(0, 80)}...${RESET}`);
    }

    // ── Baseline run (no block context) ──

    console.log(`  ${DIM}Generating baseline response...${RESET}`);
    let baselineOutput;
    try {
      baselineOutput = await generateResponse(evalItem.prompt, null, model);
    } catch (err) {
      console.error(`  ${RED}Baseline generation failed: ${err.message}${RESET}`);
      continue;
    }

    if (verbose) {
      console.log(`  ${DIM}Baseline output (first 200 chars):${RESET}`);
      console.log(`  ${DIM}${baselineOutput.substring(0, 200)}...${RESET}`);
    }

    // ── Treatment run (with block context) ──

    console.log(`  ${DIM}Generating treatment response...${RESET}`);
    let treatmentOutput;
    try {
      treatmentOutput = await generateResponse(evalItem.prompt, systemContext, model);
    } catch (err) {
      console.error(`  ${RED}Treatment generation failed: ${err.message}${RESET}`);
      continue;
    }

    if (verbose) {
      console.log(`  ${DIM}Treatment output (first 200 chars):${RESET}`);
      console.log(`  ${DIM}${treatmentOutput.substring(0, 200)}...${RESET}`);
    }

    // ── Run assertions against both ──

    const assertions = evalItem.assertions || [];
    const baselineResults = [];
    const treatmentResults = [];

    for (const assertion of assertions) {
      const baselineResult = await runAssertion(baselineOutput, assertion);
      baselineResults.push(baselineResult);

      const treatmentResult = await runAssertion(treatmentOutput, assertion);
      treatmentResults.push(treatmentResult);
    }

    // ── Print results ──

    console.log(`  Baseline:`);
    for (let i = 0; i < assertions.length; i++) {
      printAssertionResult(baselineResults[i], assertions[i], verbose);
    }

    console.log(`  Treatment:`);
    for (let i = 0; i < assertions.length; i++) {
      printAssertionResult(treatmentResults[i], assertions[i], verbose);
    }

    const baselinePassRate = computePassRate(baselineResults);
    const treatmentPassRate = computePassRate(treatmentResults);
    const delta = (treatmentPassRate - baselinePassRate) * 100;

    const baselinePassed = baselineResults.filter(r => r.pass).length;
    const treatmentPassed = treatmentResults.filter(r => r.pass).length;

    totalBaselinePass += baselinePassed;
    totalTreatmentPass += treatmentPassed;
    totalAssertions += assertions.length;

    let deltaStr;
    if (delta > 0) {
      deltaStr = `${GREEN}+${delta.toFixed(0)}%${RESET}`;
    } else if (delta === 0) {
      deltaStr = `${YELLOW}+0%${RESET} ${DIM}(already correct)${RESET}`;
    } else {
      deltaStr = `${RED}${delta.toFixed(0)}%${RESET} ${DIM}(regression)${RESET}`;
    }

    console.log(`  Delta: ${deltaStr}`);
    console.log();
  }

  // ── Overall HD Score ──

  const overallBaselineRate = totalAssertions > 0 ? (totalBaselinePass / totalAssertions) * 100 : 0;
  const overallTreatmentRate = totalAssertions > 0 ? (totalTreatmentPass / totalAssertions) * 100 : 0;
  const hdScore = overallTreatmentRate - overallBaselineRate;

  console.log(SEP);

  let hdColor;
  if (hdScore > 0) hdColor = GREEN;
  else if (hdScore === 0) hdColor = YELLOW;
  else hdColor = RED;

  console.log(`${BOLD}HD Score: ${hdColor}+${hdScore.toFixed(1)}%${RESET} (${totalBaselinePass}/${totalAssertions} \u2192 ${totalTreatmentPass}/${totalAssertions} assertions)`);
  console.log(`  Baseline pass rate:     ${overallBaselineRate.toFixed(1)}%`);
  console.log(`  Treatment pass rate:    ${overallTreatmentRate.toFixed(1)}%`);
  console.log(`  Hallucination Delta:    ${hdColor}+${hdScore.toFixed(1)}%${RESET}`);
  console.log();

  return {
    blockName,
    model,
    totalAssertions,
    baselinePassRate: overallBaselineRate,
    treatmentPassRate: overallTreatmentRate,
    hdScore,
  };
}

// ── Eval all installed blocks that have evals.yaml ──

export async function runEvalAll(verbose = false) {
  // Scan PACKAGES_DIR for blocks with evals.yaml
  if (!existsSync(PACKAGES_DIR)) {
    console.error(`No packages installed. Run 'lingot add <block>' first.`);
    process.exit(1);
  }

  const { readdirSync } = await import('fs');
  const entries = readdirSync(PACKAGES_DIR, { withFileTypes: true });
  const blocksWithEvals = entries
    .filter(e => e.isDirectory())
    .filter(e => existsSync(join(PACKAGES_DIR, e.name, 'evals.yaml')))
    .map(e => e.name);

  if (blocksWithEvals.length === 0) {
    console.log('No blocks with evals.yaml found in installed packages.');
    console.log(`Packages directory: ${PACKAGES_DIR}`);
    return;
  }

  console.log(`\n${BOLD}AII Eval — All Blocks${RESET}`);
  console.log(`Found ${blocksWithEvals.length} block(s) with evals: ${blocksWithEvals.join(', ')}\n`);

  const results = [];

  for (const block of blocksWithEvals) {
    try {
      const result = await runEval(block, verbose);
      results.push(result);
    } catch (err) {
      console.error(`${RED}Error evaluating ${block}: ${err.message}${RESET}`);
    }
  }

  // ── Summary table ──

  if (results.length > 1) {
    const SEP = '\u2550'.repeat(40);
    console.log(SEP);
    console.log(`${BOLD}Summary${RESET}\n`);
    console.log(`  ${'Block'.padEnd(25)} ${'Baseline'.padStart(10)} ${'Treatment'.padStart(10)} ${'HD Score'.padStart(10)}`);
    console.log(`  ${'─'.repeat(25)} ${'─'.repeat(10)} ${'─'.repeat(10)} ${'─'.repeat(10)}`);

    for (const r of results) {
      const hdColor = r.hdScore > 0 ? GREEN : r.hdScore === 0 ? YELLOW : RED;
      console.log(`  ${r.blockName.padEnd(25)} ${(r.baselinePassRate.toFixed(1) + '%').padStart(10)} ${(r.treatmentPassRate.toFixed(1) + '%').padStart(10)} ${hdColor}${('+' + r.hdScore.toFixed(1) + '%').padStart(10)}${RESET}`);
    }
    console.log();
  }
}
