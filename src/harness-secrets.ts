import { execFileSync } from "node:child_process";

/**
 * Machine-local secret resolution (Phase 2, 2.1 -- the L9 mechanism,
 * docs/harness/18). The harness never holds a secret VALUE; it resolves a
 * declared name against a machine-local source at the moment it's needed. A
 * resolver answers only "does this name resolve here?" (a boolean) -- it does
 * not return or log the value. Default source order: process env, then (on
 * macOS, opt-in) the login keychain. Credential brokering + JIT scoped tokens
 * are the deferred upgrade; the posture (names-only, machine-local) is set here.
 */

export interface SecretSource {
  readonly name: string;
  has(secretName: string): boolean;
}

/** Environment variables -- the default machine-local source. */
export const envSource: SecretSource = {
  name: "env",
  has(secretName: string): boolean {
    const v = process.env[secretName];
    return typeof v === "string" && v.length > 0;
  },
};

/**
 * macOS login keychain, via `security find-generic-password`. Opt-in (not in the
 * default order) because it can prompt; enable explicitly where a headless run
 * has keychain access. Never returns the value -- only whether the item exists.
 */
export const keychainSource: SecretSource = {
  name: "keychain",
  has(secretName: string): boolean {
    try {
      execFileSync("security", ["find-generic-password", "-s", secretName], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  },
};

/** Build a resolver over the given sources (first that has it wins). */
export function makeSecretResolver(sources: readonly SecretSource[] = [envSource]): (name: string) => boolean {
  return (name: string) => sources.some((s) => s.has(name));
}

/** The default resolver: environment only (safe, no prompts). */
export const resolveSecret = makeSecretResolver();
