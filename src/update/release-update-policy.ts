export const RUNTIME_RELEASE_SCHEMA_VERSION = "kab.runtime-release.v1" as const;
export const AGENT_BRIDGE_TECHNICAL_PRODUCT_ID = "agent-bridge" as const;

export type RuntimeReleaseChannel = "stable" | "candidate";

export interface RuntimeReleaseDescriptor {
  schemaVersion: typeof RUNTIME_RELEASE_SCHEMA_VERSION;
  technicalProductId: typeof AGENT_BRIDGE_TECHNICAL_PRODUCT_ID;
  packageVersion: string;
  artifactSha256: string;
  sourceCommit: string;
  channel: RuntimeReleaseChannel;
}

export interface InstalledRuntimeRelease {
  packageVersion: string;
  artifactSha256: string;
  sourceCommit: string;
}

export interface RuntimeUpdatePolicyOptions {
  allowCandidate?: boolean | undefined;
  trustedRollbackTarget?: InstalledRuntimeRelease | undefined;
}

export type RuntimeUpdateDecision =
  | {
      outcome: "noop";
      reason: "already_installed";
      target: RuntimeReleaseDescriptor;
    }
  | {
      outcome: "update";
      reason: "newer_release";
      target: RuntimeReleaseDescriptor;
    }
  | {
      outcome: "rollback";
      reason: "trusted_previous_release";
      target: RuntimeReleaseDescriptor;
    }
  | {
      outcome: "reject";
      reason:
        | "invalid_release_descriptor"
        | "version_digest_collision"
        | "downgrade_blocked"
        | "candidate_blocked"
        | "untrusted_rollback_target";
      message: string;
      target: RuntimeReleaseDescriptor;
    };

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/i;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function evaluateRuntimeUpdate(
  current: InstalledRuntimeRelease,
  target: RuntimeReleaseDescriptor,
  options: RuntimeUpdatePolicyOptions = {},
): RuntimeUpdateDecision {
  const currentVersion = parseSemver(current.packageVersion);
  const targetVersion = validateReleaseDescriptor(target);

  if (!currentVersion || !isInstalledReleaseValid(current) || !targetVersion) {
    return reject(
      target,
      "invalid_release_descriptor",
      "Current or target release metadata is not valid.",
    );
  }

  if (
    target.channel === "candidate" &&
    !options.allowCandidate &&
    compareSemver(targetVersion, currentVersion) >= 0
  ) {
    return reject(
      target,
      "candidate_blocked",
      "Candidate releases require an explicit deployment opt-in.",
    );
  }

  const comparison = compareSemver(targetVersion, currentVersion);
  const currentDigest = normalizeSha256(current.artifactSha256);
  const targetDigest = normalizeSha256(target.artifactSha256);

  if (comparison === 0) {
    if (currentDigest === targetDigest) {
      return { outcome: "noop", reason: "already_installed", target };
    }
    return reject(
      target,
      "version_digest_collision",
      "The same package version cannot resolve to a different artifact digest.",
    );
  }

  if (comparison > 0) {
    return { outcome: "update", reason: "newer_release", target };
  }

  const trustedRollback = options.trustedRollbackTarget;
  if (!trustedRollback) {
    return reject(
      target,
      "downgrade_blocked",
      "Downgrades are blocked unless the exact previous installed release is trusted for rollback.",
    );
  }

  if (!isInstalledReleaseValid(trustedRollback)) {
    return reject(
      target,
      "untrusted_rollback_target",
      "Trusted rollback metadata is invalid.",
    );
  }

  const rollbackMatches =
    trustedRollback.packageVersion === target.packageVersion &&
    normalizeSha256(trustedRollback.artifactSha256) === targetDigest &&
    trustedRollback.sourceCommit.toLowerCase() === target.sourceCommit.toLowerCase();

  if (!rollbackMatches) {
    return reject(
      target,
      "untrusted_rollback_target",
      "Rollback is allowed only to the exact previously installed version, digest, and source commit.",
    );
  }

  return { outcome: "rollback", reason: "trusted_previous_release", target };
}

export function validateReleaseDescriptor(
  release: RuntimeReleaseDescriptor,
): ParsedSemver | null {
  const version = parseSemver(release.packageVersion);
  if (
    release.schemaVersion !== RUNTIME_RELEASE_SCHEMA_VERSION ||
    release.technicalProductId !== AGENT_BRIDGE_TECHNICAL_PRODUCT_ID ||
    !version ||
    !SHA256_PATTERN.test(release.artifactSha256) ||
    !COMMIT_PATTERN.test(release.sourceCommit)
  ) {
    return null;
  }

  if (release.channel === "stable" && version.prerelease.length > 0) {
    return null;
  }

  return version;
}

export function normalizeSha256(value: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new Error("Invalid SHA-256 digest.");
  }
  return value.toLowerCase();
}

function isInstalledReleaseValid(release: InstalledRuntimeRelease): boolean {
  return Boolean(
    parseSemver(release.packageVersion) &&
      SHA256_PATTERN.test(release.artifactSha256) &&
      COMMIT_PATTERN.test(release.sourceCommit),
  );
}

function reject(
  target: RuntimeReleaseDescriptor,
  reason: Extract<RuntimeUpdateDecision, { outcome: "reject" }>['reason'],
  message: string,
): RuntimeUpdateDecision {
  return { outcome: "reject", reason, message, target };
}

function parseSemver(value: string): ParsedSemver | null {
  const match = SEMVER_PATTERN.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareSemver(a: ParsedSemver, b: ParsedSemver): number {
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1;
  }

  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;

  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index];
    const right = b.prerelease[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;

    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      const leftNumber = Number(left);
      const rightNumber = Number(right);
      if (leftNumber !== rightNumber) return leftNumber > rightNumber ? 1 : -1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left > right ? 1 : -1;
  }

  return 0;
}
