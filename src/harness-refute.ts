import { measuredClaudeRun } from "./harness-dispatch";

/**
 * Adversarial refuters (docs/harness/routing-and-verify.md section 4b, docs/harness/16
 * "Adversarial verification"). For high-stakes findings a deterministic check does not
 * cover, N INDEPENDENT refuters each try to FALSIFY that an output satisfies its spec;
 * majority-refute kills it. This is maker != checker at the judgment lane: refuters are
 * A10 floor work (a refuter role NEVER routes to a cheap tier), so the default runner
 * always dispatches on the Max subscription, model "sonnet" -- never leanRun/bulk.
 *
 * Fail-safe: an unparseable or errored vote counts as refuted. Uncertainty kills.
 */

export interface RefuteVerdict {
  readonly refuted: boolean;
  readonly reason: string;
}

export type RefuteRunner = (prompt: string) => Promise<{ text: string; exit: number }>;

function buildRefutePrompt(spec: string, output: string): string {
  return [
    "You are an adversarial refuter. Try to FALSIFY that the OUTPUT below satisfies the SPEC.",
    "Do not be agreeable -- actively look for a way the output fails the spec.",
    "Reply with exactly one verdict as the first line of your reply:",
    "`REFUTED: <reason>` if the output fails to satisfy the spec, or",
    "`SOUND: <reason>` if the output genuinely satisfies the spec.",
    "",
    "SPEC:",
    spec,
    "",
    "OUTPUT:",
    output,
  ].join("\n");
}

/** Parse the first line of a refuter reply. Tolerant of leading whitespace and case. */
function parseVerdict(text: string): RefuteVerdict {
  const firstLine = (text.split(/\r?\n/)[0] ?? "").trim();
  const m = firstLine.match(/^(refuted|sound)\s*:\s*(.*)$/i);
  if (!m) {
    return { refuted: true, reason: `unparseable first line: "${firstLine}"` };
  }
  return { refuted: m[1].toLowerCase() === "refuted", reason: m[2].trim() };
}

async function runRefuter(runner: RefuteRunner, prompt: string): Promise<RefuteVerdict> {
  let result: { text: string; exit: number };
  try {
    result = await runner(prompt);
  } catch (e: any) {
    return { refuted: true, reason: `runner errored: ${e?.message ?? e}` };
  }
  if (result.exit !== 0) {
    return { refuted: true, reason: `runner exited ${result.exit}` };
  }
  return parseVerdict(result.text);
}

/** Judgment lane, subscription billing (A10: refuters never run on a cheap external tier). */
async function defaultRunner(prompt: string): Promise<{ text: string; exit: number }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_BASE_URL;
  delete env.ANTHROPIC_AUTH_TOKEN;
  const m = measuredClaudeRun(prompt, env, undefined, "sonnet");
  return { text: m.text, exit: m.exit };
}

export async function refuteOutput(
  spec: string,
  output: string,
  opts?: { n?: number; runner?: RefuteRunner },
): Promise<{ refuted: boolean; votes: RefuteVerdict[]; survived: boolean }> {
  const requested = opts?.n ?? 3;
  // Ties impossible with odd n -- enforce it (round up).
  const n = requested % 2 === 0 ? requested + 1 : requested;
  const runner = opts?.runner ?? defaultRunner;
  const prompt = buildRefutePrompt(spec, output);
  const votes = await Promise.all(Array.from({ length: n }, () => runRefuter(runner, prompt)));
  const refutedCount = votes.filter((v) => v.refuted).length;
  const refuted = refutedCount > n / 2;
  return { refuted, votes, survived: !refuted };
}
