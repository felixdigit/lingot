---
name: research
description: Run a rigorous research pass -- ground in our own intel first, gather from live primary sources, and separate verified fact from mere claim, with a source on every claim. Invoke whenever a task needs external facts (a market landscape, a company, a spec, the current state of an art) and you would otherwise guess or lean on training data.
user-invocable: true
---

Research is not "search the web and summarize." It is three moves: ground in what we already hold, gather from live sources, and separate fact from claim. Do them in order.

1. **Check our own intel FIRST.** Before any web search, find what the studio already knows -- a competitive sheet, the brain (`pnpm brain:query`), prior research docs, a memory. Re-researching something we already track is the most common waste; a fresh pass often adds nothing our own assets did not already have. Name what you found internally before you go external.

2. **Load the web tools -- the recipe is one flag.** In a harness worker, dispatch with `--tools research` (it expands to Read/Glob/Grep/LS/ToolSearch/WebSearch/WebFetch; ToolSearch is required because a headless worker surfaces WebSearch/WebFetch as *deferred* tools it must load first). Interactively, load them with ToolSearch. Reach for the tools rather than concluding you "cannot research."

3. **Gather from live, primary sources.** Use WebSearch for current, dated facts; WebFetch to read the source itself. Prefer primary sources (the company's own page, filings, official docs, eoPortal-class references) over aggregators that echo them.

4. **Separate FACT from CLAIM.** State what is verified against what a source merely asserts -- "launched and operational" vs. "announced, not yet flying." Flag anything you could not confirm. Report real entities, specs, and dates only; an honest omission is fine, an invented fact is a defect.

5. **Attribute every claim.** Each non-obvious fact carries its source. A finding with no sources is an opinion, not research.

6. **State the delta vs. what we already knew.** Close by comparing against our own intel: what is genuinely new, what is now stale in our records (offer the correction), what we can add. The value of a research pass is usually currency + verification, not discovery -- say so plainly when that is the honest read.

**Done** = grounded in our own intel, gathered from live primary sources, fact separated from claim, every claim sourced, and the delta against what we already knew stated openly.
