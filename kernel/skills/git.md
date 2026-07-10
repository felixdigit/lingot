---
name: git
description: Commit and land work the studio way -- the commit is the circuit-breaker, staged by explicit filename, landed small; push and merge are Felix's gates. Invoke around any commit or land decision. Encodes the ELB (read the diff before committing) and the release wall.
user-invocable: true
---

The commit is the system's circuit-breaker, not a chore. Land small, land often; the push is a gated release.

1. **Read the diff before you commit (the ELB).** Never commit blind: `git diff` the change, read every hunk, then stage. A commit you did not read is a defect waiting for the next session.

2. **Stage by explicit filename.** `git add <named files>`, never `git add -A` or `commit -a` -- the working tree carries other agents' uncommitted work you must not sweep in. Commit exactly what you built.

3. **Commit each coherent unit the moment it is done.** A finished working tree holding uncommitted work is a defect, not a resting state. Land in small, frequent batches; when the ahead-of-main count climbs, land rather than let the branch diverge into a cliff.

4. **HEREDOC messages, no AI-boilerplate signature** unless asked. State what changed and why. Cite a decision id only where that surface requires it.

5. **Push and merge are Felix's gates.** `add`/`status`/`diff`/`log` and `commit -m` on named files are yours; `push`, `push -f`, `commit -a`, `reset --hard`, `branch -D`, and merge are the release path's -- never self-authorized. Landing to main surfaces as an operator-cleared act, not an assistant nudge.

6. **Prune the tail.** Merged branches and dead worktrees are cleared with `harness tidy` (safe `git branch -d` only), not left to pile up.

**Done** = the diff was read, the right files were staged by name, the unit is committed small, and any push/merge/land is left as Felix's gated act.
