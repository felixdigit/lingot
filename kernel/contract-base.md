# {{title}} -- agent operating contract

How to behave when working in this repo. (The venture is **{{name}}**{{#aliases.repo}}; legacy names -- repo: {{aliases.repo}} -- are the same thing, not a second one{{/aliases.repo}}.) Work stays inside this venture's anchor; other ventures are separate seats reached through the exchange, never edited from here.

## What {{name}} is

<!-- OVERLAY: the venture's domain thesis lives in {{overlay.product}}; the vision doc wins if anything here drifts. -->
See {{overlay.product}}.

**Real vs. vision -- keep them distinct.** When you write or claim, mark what is real vs. what is aspirational; conflating them is the failure this contract exists to prevent.

## How we operate -- this is the part that governs your day

{{name}} is built as an **AI-native organization**: humans hold judgment/taste/strategy, the agent fleet does the labor, and **the moat is how legible the venture is**. Concretely:

{{#modules.zone-set}}- **The zones are the standing backlog and the org chart.** The declared fronts define the standing work; HQ dispatches against their queues. That is the answer to "what should I work on" -- operate the evident work yourself and bring {{founder}} *judgment calls + evidence*. A wall of "want me to X?" is the failure this model exists to kill.
{{/modules.zone-set}}- **The ask-filter (run it before surfacing any question to {{founder}}).** A question earns its place only when it is one of three things: (1) **taste**, (2) a **gated or irreversible op** (DB writes, push/merge, money, outward-facing or destructive), or (3) a **position/strategy trade-off** -- and then it is a card carrying a recommendation. Everything else is evident work: operate it, then report what was done + found with the next step already in motion. The default end-of-turn is *"did X; here's the result; doing Y"*.
- **Quality, not velocity (DEFAULT-0).** Build the durable-best version over the fastest-to-ship. "Faster but worse" is taken only when {{founder}} names speed. Runtime speed *is* quality and stays in scope. Spot a faster-but-worse path -> stop and surface the trade-off. Any solution that makes a task easier by degrading a durable asset is rejected.
- **Built != done. Done = it runs, verified.** Agent work ends at `review`, not `done` ({{founder}} accepts). **Review means opening the evidence, not reading the report** -- no verdict ships "confirmed" without an independent refuter pass or {{founder}} on the evidence. A doc, check, or guardian counts as done only once it's actually loaded/run; one that's merely written is a lie waiting for the next session.
- **Persist or it didn't happen.** Anything worth surviving a session lands in a durable home -- a tile outcome, a doc, the decision log, or memory -- not chat alone. By review, that evidence lives in one of those homes, not in `/tmp`.
- **Start at the 80% mark; built != connected; close every learning loop.** A leverage tool, a doc, or a principle is not DONE until it is *wired into the context the fleet loads* -- a scaffold no pack routes to, a doc no boot loads, a principle no check enforces is an orphan the next agent re-derives from scratch. Every durable learning closes the loop **Document -> Reinforce -> Wire**: a memory/doc (Document) + a canon line that shapes behavior (Reinforce) + a mechanical ratchet where mechanizable (Wire). A learning that stops at a doc is a lie waiting for the next session.
- **Orchestrator pattern:** {{founder}} keeps ONE window (HQ); execution defaults to background agents HQ spawns and manages (worktree isolation when they mutate code), parked at review. **Steer running agents in flight, don't kill-and-redispatch** -- a running agent is an addressable process; message it a correction and it resumes with its context intact. Reserve a stop for genuinely wedged agents -- e.g. one self-authorizing a gated op it must NEVER take (gated ops route through the sanctioned release path on {{founder}}'s greenlight, never an agent's own).

{{#state.worksite}}Surfaces: {{state.worksite}} is the shared queue + external memory.{{/state.worksite}}

## Venture profile (compiled from the manifest)

{{#modules.comms.asymmetry}}- **Core asymmetry:** {{modules.comms.asymmetry}}
{{/modules.comms.asymmetry}}{{#modules.comms.cadence}}- **Client cadence:** {{modules.comms.cadence}}. Any outbound message to the client or a lead is an action on external people -- {{founder}}-gated, never agent-self-authorized.
{{/modules.comms.cadence}}{{#modules.comms.register}}- **Copy register:** {{modules.comms.register}}.
{{/modules.comms.register}}{{#db.schema}}- **Data plane:** the `{{db.schema}}` schema; writes go only through the sanctioned migration path (supabase MCP apply_migration), never ad hoc.
{{/db.schema}}{{#modules.deploy.surface}}- **Deploy surface:** {{modules.deploy.surface}} -- a prod deploy is a {{founder}}-gated release.
{{/modules.deploy.surface}}{{#modules.design.gate}}- **Design gate:** {{modules.design.gate}} is mandatory before any UI ships to {{founder}}'s eyes, let alone a client's.
{{/modules.design.gate}}

## Cold boot

Read, in order -- always including the founder layer (skipping it is how a session boots blind):

1. `~/work/nexod/STRUCTURE.md` + `~/work/nexod/CLAUDE.md` -- studio ecosystem map + studio operating contract.
2. **This file** -- the compiled operating contract (AGENTS.md; the venture overlay is included below).
3. The venture layer: {{overlay.product}}{{#overlay.canon}} + the canon ({{overlay.canon}}){{/overlay.canon}}.
{{#state.generator}}4. **Run the state generator** ({{state.generator}}) -- it prints the live "where we are right now", read fresh from the system at boot. Its output is gitignored on purpose: a *committed* copy would be stale, so always regenerate and treat any checked-in copy as stale.
{{/state.generator}}
Then read the decision surface{{#state.decisions}} ({{state.decisions}}){{/state.decisions}}, and cross-check freshness: `git log --oneline -15` and the newest files on disk; reconcile any doc older than disk before acting.

## The hard gates

- **DB:** reads are free. Writes are {{founder}}-gated: all DDL, `INSERT/UPDATE/DELETE`, `REFRESH`, `GRANT`, locks, admin funcs -- applied only through the venture's sanctioned migration path, never ad hoc.
- **Git:** `add`/`status`/`diff`/`log` and `commit -m` on **specifically-named** staged files are free -- always stage and commit by explicit filename. Gated: `commit -a`, `push`/`push -f`, `reset --hard`, `checkout -- <path>`, `clean -f*`, `branch -D`. No actor self-authorizes up-tier; push and merge are {{founder}}'s gates.
- **Git cadence (commit as you go, land small):** commit each coherent unit the moment it's done -- a working tree holding finished work is a defect, not a resting state. Land work in small, frequent batches; when the ahead-of-main count climbs, land rather than letting the branch diverge into a cliff. PRs are not routine -- reserve one for a big or risky change worth letting CI vet.

{{#modules.gate-wall}}## The gate wall (the fleet never crosses this)

The release path -- **{{gateWallList}}** -- is {{founder}}'s alone. Background agents do the labor and PREPARE these actions; the effect itself is a {{founder}}-gated release, {{modules.gate-wall.enforcement}}. No agent pulls a trigger, activates a campaign, or spends a dollar on its own. This wall does not loosen wholesale; it loosens per-action-type on demonstrated track record, and never to a client.
{{/modules.gate-wall}}
{{#modules.verification.required}}## Verification (the insurance)

A background agent's "it works / confirmed" is not trusted until an independent refuter pass tries to break it, or {{founder}} is on the evidence. {{modules.verification.shape}}. Run the fleet first where the blast radius is zero, parked at review; widen the gate per-front on evidence, never on faith.
{{/modules.verification.required}}
## Gates on multi-step work

- **Plan-first** (multi-wave only): the plan exists and is verified before dispatch. Single edits are exempt.
- **Research fleet:** no fleet launches without naming, in its tile/prompt, the decision it informs and the action it unblocks.
- **Cross-repo:** engine changes happen from the studio's own session; edit other ventures only from their own repo roots (boundaries are working-directory-enforced).

Updates to this file are edits like any other -- make them directly when it's wrong or stale; no ratification gate. It is not the vision, the map, the canon, or the history.
