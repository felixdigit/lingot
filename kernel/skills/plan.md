---
name: plan
description: Plan before executing multi-step work -- draft the target-state skeleton, align on scope, then execute section by section. Invoke before any multi-wave build, any external artefact, or any change whose shape is not obvious. The plan is a checked artefact, not a preamble.
user-invocable: true
---

Multi-step work without a checked plan drifts. The plan is the bridge from research (gather) to execution (build), and it is what verify later confirms against.

1. **Draft the target state first.** Before emitting code or prose, write what you intend to change, where, and in what sequence -- the skeleton. For an artefact that is the section outline; for a build, the files plus the end-to-end data flow.

2. **Trace end to end before the first line.** Walk input -> output: what each step receives, what it returns, its limits and defaults, the shape at every boundary. Most defects are a boundary that was never traced.

3. **Align on scope, then execute section by section.** Surface the skeleton for a taste/scope check before writing the whole thing -- full drafts written past the point the direction was wrong are the waste this gate prevents. Build one section, confirm, continue; never batch a wall.

4. **Match ceremony to blast radius.** A single edit needs no plan; a multi-wave effort does. Do not ritualize the small; do not wing the large.

5. **Halt and replan when it goes sideways.** When the approach stops working, stop and present the revised plan before continuing. Pushing a failing approach burns the context.

**Done** = a target-state skeleton exists, the data flow is traced end to end, scope is aligned, and execution is proceeding section by section against it.
