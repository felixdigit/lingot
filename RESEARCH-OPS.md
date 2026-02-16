# Research Operations Runbook

Institutional knowledge for running Context Engineering experiments at Lingot.

## API Tier Management

### Current Tier System (Anthropic)

| Tier | Cumulative Deposit | Sonnet RPM | Sonnet ITPM | Sonnet OTPM | Haiku RPM |
|------|-------------------|-----------|-------------|-------------|-----------|
| 1    | $5                | 50        | 30K         | 8K          | 50        |
| 2    | $40               | 1,000     | 450K        | 90K         | 1,000     |
| 3    | $200              | 2,000     | 800K        | 160K        | 2,000     |
| 4    | $400              | 4,000     | 2M          | 400K        | 4,000     |

**Advancement is instant** when cumulative deposit threshold is reached. Not monthly — lifetime deposits.

**Target tier for experiments: Tier 2 minimum, Tier 3 preferred.**

At Tier 1, a 4-experiment suite takes ~8 hours. At Tier 2, ~25 minutes. At Tier 3, ~12 minutes.

### Check Your Tier

Console: https://console.anthropic.com/settings/limits

### Rate Limit Headers

Every API response includes these headers:
- `anthropic-ratelimit-requests-remaining` — RPM headroom
- `anthropic-ratelimit-input-tokens-remaining` — ITPM headroom
- `anthropic-ratelimit-output-tokens-remaining` — OTPM headroom

## Cost Optimization Stack

### 1. Prompt Caching (implemented in clinical-trials.js)

**How it works:** System context (block content) is identical across all 20 runs per config. First call pays a 25% write premium. Runs 2-20 pay 90% LESS for input tokens. Cached tokens also **don't count toward ITPM rate limits**.

**Impact:**
- Cost: ~40% cheaper on input tokens across a 20-run config
- Speed: Cached tokens free up ITPM budget, effectively 5-10x throughput
- Minimum cacheable: 1,024 tokens (Sonnet), 4,096 tokens (Haiku)
- TTL: 5 minutes (auto-refreshed on each hit)

**Pricing (Sonnet 4.x):**
| Token Type | Cost per MTok |
|-----------|--------------|
| Base input | $3.00 |
| Cache write (first call) | $3.75 |
| Cache read (subsequent) | $0.30 |
| Output | $15.00 |

### 2. Batch API — DO NOT USE

**CRITICAL (from Deep Think 004):** Batch API **disables prompt caching**. The 50% Batch discount is far less than the 90% caching discount on input tokens.

**The math:** Standard API + caching: first run pays 100%, runs 2-39 pay ~10%. Effective cost = ~12% of base.
Batch API: every run pays 50%. Effective cost = 50% of base.

**Standard API + caching is 4x cheaper than Batch API** for any workload with repeated system contexts (which is ALL our experiments).

**Instead:** Queue trials sequentially by block_hash. Exhaust all runs for one config within the 5-minute cache TTL before moving to the next. This maximizes cache hits.

### 3. MIN_DELAY_MS Tuning

The harness uses `MIN_DELAY_MS` env var to control inter-call delay:

```bash
# Tier 1 (50 RPM) — both experiments competing:
MIN_DELAY_MS=600 node ctx/scripts/clinical-trials.js --experiment B

# Tier 2 (1000 RPM) — plenty of headroom:
MIN_DELAY_MS=100 node ctx/scripts/clinical-trials.js --experiment B

# Tier 3+ — near-zero delay, let retry handle bursts:
MIN_DELAY_MS=50 node ctx/scripts/clinical-trials.js --experiment B
```

When running 2 experiments in parallel, double the delay (they share the same API key's rate limit).

## Cost Estimation Formulas

### Per-Experiment Estimates (Sonnet gen + Haiku judge)

**Without caching:**
```
gen_cost = n_calls × avg_input_tokens × $3/MTok + n_calls × avg_output_tokens × $15/MTok
judge_cost = n_judge_calls × avg_input_tokens × $1/MTok + n_judge_calls × avg_output_tokens × $5/MTok
total = gen_cost + judge_cost
```

**With caching (runs 2-20 of each config):**
```
first_run_input = input_tokens × $3.75/MTok  (cache write)
later_runs_input = input_tokens × $0.30/MTok  (cache read) × 19 runs
savings ≈ 40% on input tokens
```

### Experiment Size Reference

| Experiment | Configs | Evals/Config | Runs | Total Gen Calls | Total Judge Calls | Est. Cost (cached) |
|-----------|---------|-------------|------|-----------------|-------------------|-------------------|
| A (Interference) | 10 | 5 | 20 | 1,000 | ~1,000 | ~$8-12 |
| B (Density) | 7 | 5 | 20 | 700 | ~700 | ~$5-8 |
| C (Rot Test) | 2 | 2 | 20 | 80 | ~80 | ~$1-2 |
| D (Composition) | 6 | 5-35 | 20 | ~2,100 | ~2,100 | ~$10-15 |

## Running Experiments

### Pre-flight Checklist

1. **Check API balance:** https://console.anthropic.com/settings/billing
2. **Check tier:** https://console.anthropic.com/settings/limits
3. **Estimate cost:** Use formulas above
4. **Set MIN_DELAY_MS** based on tier and parallelism
5. **ANTHROPIC_API_KEY** must be set in environment

### Launch Commands

```bash
# Single experiment
ANTHROPIC_API_KEY=sk-... node ctx/scripts/clinical-trials.js --experiment B --n 20

# Parallel experiments (split RPM budget)
MIN_DELAY_MS=200 ANTHROPIC_API_KEY=sk-... node ctx/scripts/clinical-trials.js --experiment B --n 20 &
MIN_DELAY_MS=200 ANTHROPIC_API_KEY=sk-... node ctx/scripts/clinical-trials.js --experiment D --n 20 &

# Dry run (simulated, no API calls)
node ctx/scripts/clinical-trials.js --experiment D --n 5 --dry-run

# Calibration pass
ANTHROPIC_API_KEY=sk-... node ctx/scripts/clinical-trials.js --calibrate
```

### Monitoring

- Watch progress: `tail -f /path/to/output`
- Cache performance is reported at experiment end
- CSV files saved to `ctx/trials/`

## Lessons Learned

### From Experiments A+C (Feb 2026)

1. **Two experiments sharing Tier 1 = brutal.** Experiment A took 4.2 hours. At Tier 2 it would take ~12 minutes.
2. **Retry logic is essential.** Rate limit errors happen in bursts. Exponential backoff (2s → 4s → 8s → 30s) handles it gracefully.
3. **Connection errors ≠ assertion failures.** The initial calibration run produced false 0% scores because generation calls failed, not because assertions failed. Always distinguish API errors from eval failures.
4. **Parallel experiments compete for rate limits.** If running 2+ experiments simultaneously, increase MIN_DELAY_MS proportionally.

### From Deep Think 034 Peer Review (Feb 2026)

5. **Simpson's Paradox in Experiment D.** "Rising fidelity" (87.3% → 90.7%) was an artifact of adding easier evals to the denominator. MUST test a fixed eval set across all tiers when measuring composition scaling.
6. **Pink Elephant Tax is REAL.** Knowledge-only (99.7%) > Full block (97.0%). Negative rules (`NEVER use X`) actively poison generation by spiking banned token activation. All rules.xml must be rewritten with positive attractors.
7. **Cross-pollination "improvements" were noise.** Tailwind +12.5% under joint loading evaporates under Benjamini-Hochberg FDR correction. Don't report effects < 10% at N=20 as real.
8. **"Lost in the Middle" doesn't apply to us.** Middle > Start because our blocks are instructions, not factual passages. "Lost in the Middle" applies to RAG/retrieval, not instruction adherence. Our finding is actually "Instruction Detachment" — rules at token 0 wash out before the user query.
9. **31% failure in Rot Test = Parametric Drag.** Not a failure of the block — it's the exact measurement of pre-training weight resistance. Overriding 10^7 training examples of Lucia v3 with 500 tokens requires immense force.

## Next Experiments ($50 budget)

Priority-ordered from Deep Think 034:

1. [ ] **Human Calibration** ($0, 1h) — 100 random llm_judge assertions, Cohen's Kappa. If κ < 0.85, switch judge to Sonnet.
2. [ ] **Pink Elephant Fix** (~$10) — Fork drizzle-orm rules.xml. Rewrite NEVER/AVOID/DO NOT as positive commands. Re-run Exp B ablation at N=40. Proves Theorem IV.
3. [ ] **De-confound Attention Cliff** (~$30) — Re-run Exp D (N=1-5). Test ONLY nextjs evals. Pad N=1 with 15K dummy tokens. Keep total tokens flat. Any drop = pure Instructional Overload.
4. [ ] **Model Generalizability** (~$10) — Run serial-vs-identity-column against GPT-4o. Prove interference is fundamental to transformers, not RLHF-specific.

## Future Improvements

- [ ] Add `--tier` flag to auto-configure MIN_DELAY_MS
- [ ] Log cache hit/miss per call for fine-grained optimization
- [ ] Add cost estimator (`--estimate` flag that calculates cost without running)
- [ ] Rewrite all rules.xml across 47+ blocks to use positive framing (post-Pink Elephant proof)
