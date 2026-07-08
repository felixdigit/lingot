import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { loadHarnessManifest } from "./harness-manifest";
import { KERNEL_VERSION } from "./harness-kernel";

/**
 * The lockfile (Phase 0, 0.5) -- `harness.lock` records the resolved exact
 * kernel version + the manifest's content fingerprint (docs/harness/03 Section
 * 8, APM's apm.lock.yaml). A fresh checkout compiles from the lock rather than
 * re-resolving the pin, so behavior cannot silently drift when a newer kernel
 * lands within the pinned range. Deterministic: same manifest -> same lock.
 *
 * Seed resolution: there is one kernel (KERNEL_VERSION), so "resolve the pin"
 * returns it. Semver range-satisfaction (does the pin actually admit this
 * kernel?) is a follow-on; for the seed the lock records pin + resolved + hash.
 */

export interface HarnessLock {
  readonly harness_lock: "v1";
  readonly project: string;
  /** The manifest's kernel.version pin (e.g. "~> 1.4"). */
  readonly pin: string;
  /** The resolved exact kernel version this project compiles against. */
  readonly kernel: string;
  /** sha256 of the manifest file's bytes -- the input fingerprint. */
  readonly manifest_hash: string;
}

export interface LockResult {
  readonly lock?: HarnessLock;
  readonly errors: readonly string[];
}

/** Resolve a manifest's pin to a lock (no write). */
export function resolveLock(manifestPath: string): LockResult {
  const load = loadHarnessManifest(manifestPath);
  if (!load.manifest) return { errors: load.errors };
  const raw = readFileSync(manifestPath);
  const manifest_hash = createHash("sha256").update(raw).digest("hex");
  const lock: HarnessLock = {
    harness_lock: "v1",
    project: load.manifest.identity.name,
    pin: load.manifest.kernel.version,
    kernel: KERNEL_VERSION,
    manifest_hash,
  };
  return { lock, errors: [] };
}

/** Serialize a lock to its on-disk form (stable key order, deterministic). */
export function formatLock(lock: HarnessLock): string {
  return JSON.stringify(lock, null, 2) + "\n";
}
