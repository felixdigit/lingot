---
name: verify
description: Verify work before calling it done -- the maker != checker discipline. Invoke before accepting any non-trivial result (your own, a worker's, or a tool's): run the real path, try to break it, read the evidence, and grade honestly. Use the moment a build, a claim, a research finding, or a fix is about to be called "done."
user-invocable: true
---

"It works / confirmed" is a hypothesis until an independent pass tries to break it. Built is not done; done is: it runs, verified. Follow this.

1. **The author never grades their own work.** A worker's (or your own) "all green" is the maker speaking. The checker is a SEPARATE pass with fresh eyes. If you built it, verify it as though a stranger did -- self-graded numbers are the thing this discipline exists to distrust.

2. **Run the REAL path, not a proxy.** Re-run the actual suite yourself rather than trusting a reported count. Drive the real user interaction, not a shortcut that happens to pass. "The tests pass but the user sees breakage" means you verified a proxy.

3. **Refute, don't confirm.** Actively try to break the claim: adversarial inputs, the failure modes, the edge the happy path skips. For anything security- or safety-sensitive, construct the attack yourself -- a non-authorized actor, a malformed input, a forced failure -- and confirm it is refused. Read that it should be refused is not enough; make it try.

4. **Read the evidence, not the summary.** Open the diff, the output, the logs -- the artifact itself, not the report about it. A verdict that never touched the evidence is a rumor.

5. **Grade on two axes when they differ.** "Machinery built" and "actually load-bearing in real use" are different questions; keep them separate rather than averaging them into a comforting number. State what is proven, what is assumed, and what was skipped.

**Done** = an independent pass ran the real path, tried to break it, read the evidence, and can say precisely what is proven versus still assumed.
