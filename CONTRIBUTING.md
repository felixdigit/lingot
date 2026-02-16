# Contributing to Lingot

## Creating an Intelligence Block

Each block is a directory with 3-4 files that teach AI coding agents about a specific library or framework.

### Directory Structure

```
my-block/
  knowledge.md    # Dense domain knowledge (required)
  rules.xml       # Heuristic rules (required)
  examples.yaml   # Few-shot examples (recommended)
  lingot.json     # Metadata and manifest (required)
```

### knowledge.md

The most important file. This is the structured knowledge that grounds the model.

**Guidelines:**
- Write dense, factual prose — every sentence should earn its tokens
- Use markdown headers to organize by concept area
- Include current API patterns (not deprecated ones)
- Cover mental models, not just API surface
- Target 1,000-3,000 tokens (roughly 4,000-12,000 characters)
- Include version-specific information when APIs change between versions

**Example structure:**
```markdown
# Library Name

## Mental Model
What this library is and how it works at a high level.

## Core API
The primary patterns developers need to know.

## Common Patterns
Patterns that come up in real projects.

## Version-Specific Changes
What changed in the latest version that models get wrong.
```

### rules.xml

Heuristic rules that prevent common hallucinations.

**Guidelines:**
- Write rules in **affirmative form** — say what TO do, not what to avoid
- Each rule gets a unique `id` attribute
- Keep rules specific and actionable
- 5-15 rules per block is typical

**Affirmative rule example (correct):**
```xml
<rules>
  <rule id="use-identity-columns">
    Use GENERATED ALWAYS AS IDENTITY for auto-incrementing columns. The identity column syntax is the current PostgreSQL standard.
  </rule>
</rules>
```

**Why affirmative?** Our clinical trial data (N=1,800) shows that negative rules ("NEVER use X") inject deprecated tokens into the model's attention, causing a measurable accuracy penalty we call the Pink Elephant Tax. Affirmative rules avoid this entirely.

### examples.yaml

Few-shot input/output pairs that demonstrate correct usage.

**Guidelines:**
- Each example has `id`, `input` (natural language task), and `output` (correct code)
- 3-8 examples per block
- Cover the most common tasks, not edge cases
- Keep examples realistic — actual tasks developers would ask an AI to do

```yaml
- id: basic-query
  input: "Query all users with their posts using Drizzle relational queries"
  output: |
    const users = await db.query.users.findMany({
      with: { posts: true }
    });
```

### lingot.json

Block metadata and manifest.

```json
{
  "$schema": "https://lingot.sh/schema/v2",
  "name": "my-block",
  "version": "1.0.0",
  "description": "One sentence describing what this block teaches.",
  "author": "Your Name",
  "license": "MIT",
  "domain": "database",
  "category": "developer",
  "keywords": ["relevant", "search", "terms"],
  "requires": [],
  "enhances": [],
  "conflicts": [],
  "tokens": {
    "knowledge": 0,
    "rules": 0,
    "examples": 0,
    "total": 0
  },
  "sources": [
    {
      "title": "Official Docs",
      "url": "https://docs.example.com"
    }
  ]
}
```

**Token counts:** Estimate as `Math.ceil(content.length / 4)` for each file. Update after writing all files.

**Domain values:** `auth`, `database`, `frontend`, `backend`, `testing`, `devops`, `payments`, `ai`, `email`, `infrastructure`, `monitoring`, `build-tools`

## Validating Your Block

```bash
npx lingot validate ./my-block
```

This checks:
- Required files exist
- JSON/XML/YAML parse correctly
- Token counts are reasonable
- No structural issues

## Quality Checklist

Before submitting:

- [ ] `knowledge.md` covers the current API (not deprecated patterns)
- [ ] All rules are **affirmative** (no NEVER, AVOID, DON'T, MUST NOT)
- [ ] Examples use realistic, common tasks
- [ ] Token counts in `lingot.json` match actual content
- [ ] `npx lingot validate ./my-block` passes
- [ ] `npx lingot doctor ./my-block` scores 80+
- [ ] Sources list the official docs you referenced

## Running Evals (Optional)

If you want to measure your block's impact, add an `evals.yaml`:

```yaml
- id: my-eval-scenario
  system: "You are a coding assistant."
  user: "Write code to do X using my-library"
  assertions:
    - type: contains
      value: "correctPattern"
    - type: not_contains
      value: "deprecatedPattern"
```

Then run:
```bash
npx lingot eval ./my-block --verbose
```

## Submitting

Open a PR or reach out at hello@lingot.sh with your block directory. We review for:

1. **Accuracy** — Does the knowledge reflect current APIs?
2. **Density** — Is every sentence earning its tokens?
3. **Polarity** — Are all rules affirmative?
4. **Coverage** — Does it cover the main hallucination cliffs for this library?
