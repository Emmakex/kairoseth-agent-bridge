import {
  evaluateRuntimeUpdate,
  type InstalledRuntimeRelease,
  type RuntimeReleaseDescriptor,
  type RuntimeUpdatePolicyOptions,
} from "./release-update-policy.js";

export interface DockerInstalledRuntimeRelease extends InstalledRuntimeRelease {
  imageId: string;
}

export interface DockerRuntimeActivationRequest {
  current: DockerInstalledRuntimeRelease;
  target: RuntimeReleaseDescriptor;
  candidateImageId: string;
  allowCandidate?: boolean | undefined;
  trustedRollbackTarget?: DockerInstalledRuntimeRelease | undefined;
}

export type DockerRuntimeActivationPlan =
  | {
      outcome: "noop";
      reason: "already_installed";
      activeImageId: string;
      target: RuntimeReleaseDescriptor;
    }
  | {
      outcome: "activate";
      reason: "newer_release" | "trusted_previous_release";
      mode: "update" | "rollback";
      current: DockerInstalledRuntimeRelease;
      target: RuntimeReleaseDescriptor;
      candidateImageId: string;
      rollbackImageId: string;
    }
  | {
      outcome: "reject";
      reason:
        | "invalid_current_image_id"
        | "invalid_candidate_image_id"
        | "invalid_trusted_rollback_image_id"
        | "image_identity_collision"
        | "invalid_release_descriptor"
        | "version_digest_collision"
        | "downgrade_blocked"
        | "candidate_blocked"
        | "untrusted_rollback_target";
      message: string;
      target: RuntimeReleaseDescriptor;
    };

const DOCKER_IMAGE_ID_PATTERN = /^sha256:[a-f0-9]{64}$/i;

export function buildDockerRuntimeActivationPlan(
  request: DockerRuntimeActivationRequest,
): DockerRuntimeActivationPlan {
  const currentImageId = normalizeDockerImageId(request.current.imageId);
  if (!currentImageId) {
    return reject(
      request.target,
      "invalid_current_image_id",
      "The currently installed Docker image ID is not an immutable sha256 image ID.",
    );
  }

  const candidateImageId = normalizeDockerImageId(request.candidateImageId);
  if (!candidateImageId) {
    return reject(
      request.target,
      "invalid_candidate_image_id",
      "The candidate Docker image ID is not an immutable sha256 image ID.",
    );
  }

  let trustedRollbackTarget: InstalledRuntimeRelease | undefined;
  if (request.trustedRollbackTarget) {
    const rollbackImageId = normalizeDockerImageId(
      request.trustedRollbackTarget.imageId,
    );
    if (!rollbackImageId) {
      return reject(
        request.target,
        "invalid_trusted_rollback_image_id",
        "The trusted rollback Docker image ID is invalid.",
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
    if (candidateImageId !== currentImageId) {
      return reject(
        request.target,
        "image_identity_collision",
        "The same release descriptor cannot resolve to a different Docker image ID.",
      );
    }

    return {
      outcome: "noop",
      reason: "already_installed",
      activeImageId: currentImageId,
      target: request.target,
    };
  }

  return {
    outcome: "activate",
    reason: decision.reason,
    mode: decision.outcome === "rollback" ? "rollback" : "update",
    current: {
      ...request.current,
      imageId: currentImageId,
    },
    target: request.target,
    candidateImageId,
    rollbackImageId: currentImageId,
  };
}

export function normalizeDockerImageId(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  return DOCKER_IMAGE_ID_PATTERN.test(normalized) ? normalized : null;
}

function reject(
  target: RuntimeReleaseDescriptor,
  reason: Extract<DockerRuntimeActivationPlan, { outcome: "reject" }>['reason'],
  message: string,
): DockerRuntimeActivationPlan {
  return { outcome: "reject", reason, message, target };
}
