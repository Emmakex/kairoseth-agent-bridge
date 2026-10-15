import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDockerRuntimeActivationPlan,
  type DockerInstalledRuntimeRelease,
  type RuntimeReleaseDescriptor,
} from "../../src/index.js";

const IMAGE_A = `sha256:${"a".repeat(64)}`;
const IMAGE_B = `sha256:${"b".repeat(64)}`;
const IMAGE_C = `sha256:${"c".repeat(64)}`;
const ARTIFACT_A = "1".repeat(64);
const ARTIFACT_B = "2".repeat(64);
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

function installed(
  version = "1.0.0",
  artifactSha256 = ARTIFACT_A,
  sourceCommit = COMMIT_A,
  imageId = IMAGE_A,
): DockerInstalledRuntimeRelease {
  return { packageVersion: version, artifactSha256, sourceCommit, imageId };
}

function release(
  version: string,
  artifactSha256: string,
  sourceCommit: string,
  channel: "stable" | "candidate" = "stable",
): RuntimeReleaseDescriptor {
  return {
    schemaVersion: "kab.runtime-release.v1",
    technicalProductId: "agent-bridge",
    packageVersion: version,
    artifactSha256,
    sourceCommit,
    channel,
  };
}

test("newer release activation keeps exact previous Docker image as rollback target", () => {
  const plan = buildDockerRuntimeActivationPlan({
    current: installed(),
    target: release("1.1.0", ARTIFACT_B, COMMIT_B),
    candidateImageId: IMAGE_B,
  });

  assert.equal(plan.outcome, "activate");
  if (plan.outcome !== "activate") return;
  assert.equal(plan.mode, "update");
  assert.equal(plan.rollbackImageId, IMAGE_A);
  assert.equal(plan.candidateImageId, IMAGE_B);
});

test("same release descriptor cannot silently resolve to another Docker image", () => {
  const plan = buildDockerRuntimeActivationPlan({
    current: installed(),
    target: release("1.0.0", ARTIFACT_A, COMMIT_A),
    candidateImageId: IMAGE_B,
  });

  assert.equal(plan.outcome, "reject");
  if (plan.outcome !== "reject") return;
  assert.equal(plan.reason, "image_identity_collision");
});

test("lower version remains blocked without an exact trusted rollback release", () => {
  const plan = buildDockerRuntimeActivationPlan({
    current: installed("1.1.0", ARTIFACT_B, COMMIT_B, IMAGE_B),
    target: release("1.0.0", ARTIFACT_A, COMMIT_A),
    candidateImageId: IMAGE_A,
  });

  assert.equal(plan.outcome, "reject");
  if (plan.outcome !== "reject") return;
  assert.equal(plan.reason, "downgrade_blocked");
});

test("exact trusted previous release can be planned as rollback to its immutable image", () => {
  const previous = installed("1.0.0", ARTIFACT_A, COMMIT_A, IMAGE_A);
  const current = installed("1.1.0", ARTIFACT_B, COMMIT_B, IMAGE_B);

  const plan = buildDockerRuntimeActivationPlan({
    current,
    target: release("1.0.0", ARTIFACT_A, COMMIT_A),
    candidateImageId: IMAGE_A,
    trustedRollbackTarget: previous,
  });

  assert.equal(plan.outcome, "activate");
  if (plan.outcome !== "activate") return;
  assert.equal(plan.mode, "rollback");
  assert.equal(plan.candidateImageId, IMAGE_A);
  assert.equal(plan.rollbackImageId, IMAGE_B);
});

test("invalid current, candidate, and trusted rollback image identities fail closed", () => {
  const target = release("1.1.0", ARTIFACT_B, COMMIT_B);

  assert.equal(
    buildDockerRuntimeActivationPlan({
      current: installed("1.0.0", ARTIFACT_A, COMMIT_A, "agent-bridge:latest"),
      target,
      candidateImageId: IMAGE_B,
    }).outcome,
    "reject",
  );

  const candidate = buildDockerRuntimeActivationPlan({
    current: installed(),
    target,
    candidateImageId: "agent-bridge:candidate",
  });
  assert.equal(candidate.outcome, "reject");
  if (candidate.outcome === "reject") {
    assert.equal(candidate.reason, "invalid_candidate_image_id");
  }

  const rollback = buildDockerRuntimeActivationPlan({
    current: installed("1.1.0", ARTIFACT_B, COMMIT_B, IMAGE_B),
    target: release("1.0.0", ARTIFACT_A, COMMIT_A),
    candidateImageId: IMAGE_A,
    trustedRollbackTarget: installed(
      "1.0.0",
      ARTIFACT_A,
      COMMIT_A,
      "sha256:not-a-real-id",
    ),
  });
  assert.equal(rollback.outcome, "reject");
  if (rollback.outcome === "reject") {
    assert.equal(rollback.reason, "invalid_trusted_rollback_image_id");
  }
});

test("candidate release still requires explicit opt-in at Docker activation layer", () => {
  const plan = buildDockerRuntimeActivationPlan({
    current: installed(),
    target: release("1.1.0-rc.1", ARTIFACT_B, COMMIT_B, "candidate"),
    candidateImageId: IMAGE_C,
  });

  assert.equal(plan.outcome, "reject");
  if (plan.outcome !== "reject") return;
  assert.equal(plan.reason, "candidate_blocked");
});
