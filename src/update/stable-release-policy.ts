const STABLE_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export interface StableReleaseIdentity {
  tag: string;
  version: string;
}

/**
 * Stable promotion is intentionally narrower than generic semver parsing:
 * release tags are exactly vMAJOR.MINOR.PATCH and package.json must contain
 * the exact same stable version. Pre-release/build metadata is never promoted
 * through the stable channel.
 */
export function validateStableReleaseIdentity(
  tag: string,
  packageVersion: string,
): StableReleaseIdentity {
  if (!STABLE_SEMVER.test(packageVersion)) {
    throw new Error(
      "Stable release package version must be exact MAJOR.MINOR.PATCH without prerelease or build metadata.",
    );
  }

  const expectedTag = `v${packageVersion}`;
  if (tag !== expectedTag) {
    throw new Error(
      `Stable release tag must exactly match package version (${expectedTag}).`,
    );
  }

  return { tag, version: packageVersion };
}
