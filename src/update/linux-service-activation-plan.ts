import { posix } from "node:path";

import {
  evaluateRuntimeUpdate,
  normalizeSha256,
  type InstalledRuntimeRelease,
  type RuntimeReleaseDescriptor,
  type RuntimeUpdatePolicyOptions,
} from "./release-update-policy.js";

export interface LinuxInstalledRuntimeRelease extends InstalledRuntimeRelease {
  releasePath: string;
}

export interface LinuxServiceActivationRequest {
  current: LinuxInstalledRuntimeRelease;
  target: RuntimeReleaseDescriptor;
  candidateReleasePath: string;
  allowCandidate?: boolean | undefined;
  trustedRollbackTarget?: LinuxInstalledRuntimeRelease | undefined;
}

export type LinuxServiceActivationPlan =
  | {
      outcome: "noop";
      reason: "already_installed";
      activeReleasePath: string;
      target: RuntimeReleaseDescriptor;
    }
  | {
      outcome: "activate";
      reason: "newer_release" | "trusted_previous_release";
      mode: "update" | "rollback";
      current: LinuxInstalledRuntimeRelease;
      target: RuntimeReleaseDescriptor;
      candidateReleasePath: string;
      rollbackReleasePath: string;
    }
  | {
      outcome: "reject";
      reason:
        | "invalid_current_release_path"
        | "invalid_candidate_release_path"
        | "invalid_trusted_rollback_release_path"
        | "release_path_collision"
        | "invalid_release_descriptor"
        | "version_digest_collision"
        | "downgrade_blocked"
        | "candidate_blocked"
        | "untrusted_rollback_target";
      message: string;
      target: RuntimeReleaseDescriptor;
    };

export function buildLinuxServiceActivationPlan(
  request: LinuxServiceActivationRequest,
): LinuxServiceActivationPlan {
  const currentReleasePath = normalizeReleasePath(
    request.current.releasePath,
    request.current.artifactSha256,
  );
  if (!currentReleasePath) {
    return reject(
      request.target,
      "invalid_current_release_path",
      "The currently installed Linux release path is not an absolute digest-bound release directory.",
    );
  }

  const candidateReleasePath = normalizeReleasePath(
    request.candidateReleasePath,
    request.target.artifactSha256,
  );
  if (!candidateReleasePath) {
    return reject(
      request.target,
      "invalid_candidate_release_path",
      "The candidate Linux release path is not bound to the target artifact digest.",
    );
  }

  let trustedRollbackTarget: InstalledRuntimeRelease | undefined;
  let trustedRollbackReleasePath: string | undefined;
  if (request.trustedRollbackTarget) {
    trustedRollbackReleasePath = normalizeReleasePath(
      request.trustedRollbackTarget.releasePath,
      request.trustedRollbackTarget.artifactSha256,
    ) ?? undefined;

    if (!trustedRollbackReleasePath) {
      return reject(
        request.target,
        "invalid_trusted_rollback_release_path",
        "The trusted rollback Linux release path is invalid.",
      );
    }

    trustedRollbackTarget = {
      packageVersion: request.trustedRollbackTarget.packageVersion,
      artifactSha256: request.trustedRollbackTarget.artifactSha256,
      sourceCommit: request.trustedRollbackTarget.sourceCommit,
    };
  }

  const options: RuntimeUpdatePolicyOptions = {
    ...(request.allowCandidate !== undefined
      ? { allowCandidate: request.allowCandidate }
      : {}),
    ...(trustedRollbackTarget ? { trustedRollbackTarget } : {}),
  };

  const decision = evaluateRuntimeUpdate(
    {
      packageVersion: request.current.packageVersion,
      artifactSha256: request.current.artifactSha256,
      sourceCommit: request.current.sourceCommit,
    },
    request.target,
    options,
  );

  if (decision.outcome === "reject") {
    return reject(request.target, decision.reason, decision.message);
  }

  if (decision.outcome === "noop") {
    if (candidateReleasePath !== currentReleasePath) {
      return reject(
        request.target,
        "release_path_collision",
        "The same release descriptor cannot resolve to a different Linux release directory.",
      );
    }

    return {
      outcome: "noop",
      reason: "already_installed",
      activeReleasePath: currentReleasePath,
      target: request.target,
    };
  }

  return {
    outcome: "activate",
    reason: decision.reason,
    mode: decision.outcome === "rollback" ? "rollback" : "update",
    current: {
      ...request.current,
      releasePath: currentReleasePath,
    },
    target: request.target,
    candidateReleasePath,
    rollbackReleasePath: currentReleasePath,
  };
}

export function linuxReleaseDirectoryName(artifactSha256: string): string {
  return `sha256-${normalizeSha256(artifactSha256)}`;
}

export function normalizeReleasePath(
  value: string,
  artifactSha256: string,
): string | null {
  const trimmed = value.trim();
  if (!trimmed || !posix.isAbsolute(trimmed) || trimmed.includes("\0")) {
    return null;
  }

  let expectedName: string;
  try {
    expectedName = linuxReleaseDirectoryName(artifactSha256);
  } catch {
    return null;
  }

  const normalized = posix.normalize(trimmed);
  if (normalized === "/" || posix.basename(normalized) !== expectedName) {
    return null;
  }

  return normalized;
}

function reject(
  target: RuntimeReleaseDescriptor,
  reason: Extract<LinuxServiceActivationPlan, { outcome: "reject" }>["reason"],
  message: string,
): LinuxServiceActivationPlan {
  return { outcome: "reject", reason, message, target };
}
