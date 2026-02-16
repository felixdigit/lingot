import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import semver from 'semver';

/**
 * Read the project's package.json and extract all dependency versions.
 * Returns a flat object mapping package name -> installed version string.
 */
export function getProjectDependencies() {
  const pkgPath = join(process.cwd(), 'package.json');
  if (!existsSync(pkgPath)) return {};
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return { ...pkg.dependencies, ...pkg.devDependencies };
  } catch {
    return {};
  }
}

/**
 * Check whether a block's targetDependencies are satisfied by the project's
 * installed dependency versions.
 *
 * @param {object} blockManifest - The parsed lingot.json of the block
 * @param {object} projectDeps   - Output of getProjectDependencies()
 * @returns {string[]} Array of human-readable warning strings (empty = all good)
 */
export function checkCompatibility(blockManifest, projectDeps) {
  const warnings = [];
  const targetDeps = blockManifest.targetDependencies || {};

  for (const [dep, range] of Object.entries(targetDeps)) {
    if (!(dep in projectDeps)) {
      // Dependency not present in the project — skip silently.
      // The block may still be useful even if the project doesn't use this dep.
      continue;
    }

    const installedRaw = projectDeps[dep];
    // Strip leading semver range characters (^, ~, >=, etc.) to get the base version
    const installedVersion = semver.coerce(installedRaw);

    if (!installedVersion) {
      // Can't parse the installed version — skip with a soft warning
      warnings.push(
        `Warning: Could not parse installed version of ${dep} ("${installedRaw}")`
      );
      continue;
    }

    if (!semver.satisfies(installedVersion.version, range)) {
      warnings.push(
        `Warning: ${blockManifest.name} targets ${dep} ${range} but you have ${installedVersion.version} installed`
      );
    }
  }

  return warnings;
}
