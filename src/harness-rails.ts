/**
 * I/O rails (docs/harness/17, the ADOPT piece): OpenAI Moderation as the first
 * output rail. A rail runs over text BEFORE it ships (route acceptance) and
 * flags harmful content; a flagged output is treated like a failed check. The
 * rail is honest about its own absence: no OPENAI_API_KEY -> skipped=reason,
 * flagged=false -- callers decide their posture (workers keep WebFetch off
 * their baseline until the rail is active; see harness-exec).
 */

export interface RailVerdict {
  readonly flagged: boolean;
  readonly categories: readonly string[];
  /** Set when the rail did not actually run (no key / API error) -- fail-open by design at THIS layer. */
  readonly skipped?: string;
}

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export async function moderationCheck(
  text: string,
  opts?: { env?: NodeJS.ProcessEnv; fetchFn?: FetchFn },
): Promise<RailVerdict> {
  const env = opts?.env ?? process.env;
  const key = env.OPENAI_API_KEY;
  if (!key) return { flagged: false, categories: [], skipped: "no OPENAI_API_KEY -- rail inactive" };
  const doFetch = opts?.fetchFn ?? (fetch as unknown as FetchFn);
  try {
    const r = await doFetch("https://api.openai.com/v1/moderations", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "omni-moderation-latest", input: text.slice(0, 32768) }),
    });
    if (!r.ok) return { flagged: false, categories: [], skipped: `moderation API ${r.status}` };
    const j = await r.json();
    const res = j?.results?.[0];
    const categories = Object.entries(res?.categories ?? {})
      .filter(([, v]) => v === true)
      .map(([k]) => k);
    return { flagged: res?.flagged === true, categories };
  } catch (e: any) {
    return { flagged: false, categories: [], skipped: `moderation error: ${e?.message ?? e}` };
  }
}

/** The rail is active when a key is present -- gates WebFetch/WebSearch restoration on worker baselines. */
export function railsActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.OPENAI_API_KEY;
}
