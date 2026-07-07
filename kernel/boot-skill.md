---
name: boot
description: Boot a sprint in this terminal -- load its full context pack (intent, durable brief, live tiles, operating protocol) and start working it. Invoke as `/boot <keyword> [tile-id]`. The optional tile id is an explicit dispatch -- that tile is yours, take no other. Use when a terminal/agent is dedicated to one {{name}} sprint and needs to orient and pick up work, including continuing tasks already in progress.
user-invocable: true
---

You are being assigned to one {{name}} sprint, and this terminal is dedicated to it. Orient, then work.

1. **Load the context pack.** {{#state.worksite}}Use the worksite ({{state.worksite}}) to boot the sprint by keyword; if no keyword was given, list the sprints and ask which.{{/state.worksite}}{{^state.worksite}}<OVERLAY: this venture has no worksite yet -- the sprint brief is the context pack; read it whole.>{{/state.worksite}}

2. **Actually read it all.** The context pack gives the sprint intent, the durable brief, and the live tiles (each with scope / grounding / progress). Go read the docs the brief points to before doing anything -- that is the real context, including where any in-progress tile left off. {{#state.generator}}Also orient on the whole: run the state generator ({{state.generator}}) -- regenerate it, never read a stale committed copy.{{/state.generator}}

   **Identity is visible, always:** your first reply after booting STARTS with one line -- `I am <identity> on tile <id> (<short title>)` -- and you repeat that header at the top of every review handoff. {{founder}} runs several terminals; an unlabeled one is an unroutable one.

3. **Pick a tile -- collision-safe, in this order:**
   - **If a tile id was passed**: that tile is your explicit dispatch. Claim it and take no other.
   - **Otherwise, claim atomically** -- never eyeball the board and grab the top todo (two terminals booting the same sprint would race). The queue hands you the next eligible tile; if it returns nothing, every remaining tile is claimed, blocked, or human-owned -- report that instead of taking someone else's.
   - A `doing` tile whose owner matches you can be resumed directly -- read its progress first. Never touch a tile owned by another terminal or by a human.

4. **Work, and keep the context current** so the next agent (or you tomorrow) can pick up cleanly: keep the tile's outcome line honest as you go, and keep the terminal registry honest -- check in at boot, at claim, and at review. Estimate window fullness honestly; when it passes ~70%, say so -- HQ will prefer a fresh terminal for the next deep tile.

5. **Hand off, don't self-close.** When the work is finished and self-verified: move the tile to **review** -- agent work ends at review, not done. `done` is {{founder}}'s move; you may move review->done yourself only when {{founder}} explicitly accepts in-session.

6. **Worktree rule.** If two or more *build* tiles are being worked in parallel terminals, the later ones work in a dedicated git worktree instead of the shared checkout (research/ops work doesn't need this). Create it with the venture's helper -- never by hand, never by copying files. A fresh worktree agent is born without `node_modules` -- STEP 0 is the venture's bootstrap script before any typecheck/validate.

Stay inside this sprint's scope -- the other sprints run in their own terminals. Honor {{overlay.contract}} and the brief's constraints.
